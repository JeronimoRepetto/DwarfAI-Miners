import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkQuarantine, runQuarantineCheck } from './quarantine.mjs'

/**
 * L7 check of the flake quarantine (testing strategy `17` §5.4).
 *
 * `test-quarantine.json` is the only way to stop a flaky test from blocking. Each entry names the
 * test title, its lane, the issue link, the owner role and an expiry date at most 14 days after
 * the entry was added; an expired entry fails CI.
 */

const TODAY = '2026-09-30'

const entry = (overrides = {}) => ({
  title: '[ADR-003] the pipe rejects a remote client',
  lane: 'L8',
  issue: 'https://github.com/example/repo/issues/1',
  owner: 'platform developer',
  added: '2026-09-28',
  expires: '2026-10-10',
  ...overrides
})

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

describe('flake quarantine (17 §5.4)', () => {
  it('[ADR-001] an expired test-quarantine.json entry fails; an entry longer than 14 days fails; a valid entry passes', () => {
    expect(checkQuarantine([], TODAY), 'an empty quarantine').toEqual([])
    expect(checkQuarantine([entry()], TODAY), 'a valid entry').toEqual([])
    expect(checkQuarantine([entry({ expires: TODAY })], TODAY), 'an entry expiring today').toEqual(
      []
    )

    const expired = checkQuarantine([entry({ added: '2026-09-15', expires: '2026-09-29' })], TODAY)
    expect(expired.join('\n')).toMatch(/expired on 2026-09-29/)

    const tooLong = checkQuarantine([entry({ added: '2026-09-28', expires: '2026-10-13' })], TODAY)
    expect(tooLong.join('\n')).toMatch(/more than 14 days/)
    expect(
      checkQuarantine([entry({ added: '2026-09-28', expires: '2026-10-12' })], TODAY),
      'exactly 14 days'
    ).toEqual([])
  })

  it('[ADR-001] a quarantine entry that lacks a field or a real date fails', () => {
    expect(checkQuarantine([entry({ owner: '' })], TODAY).join('\n')).toMatch(/owner/)
    expect(checkQuarantine([entry({ expires: '2026-02-30' })], TODAY).join('\n')).toMatch(
      /not a date/
    )
    expect(checkQuarantine([entry({ added: '2026-10-11' })], TODAY).join('\n')).toMatch(
      /added after it expires/
    )
    expect(checkQuarantine({}, TODAY).join('\n')).toMatch(/JSON array/)
  })

  it('[ADR-001] the command reads test-quarantine.json and fails on an expired entry', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'quarantine-'))
    tempRoots.push(dir)
    const file = path.join(dir, 'test-quarantine.json')
    const lines = { out: [], err: [] }
    const io = { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) }

    writeFileSync(file, '[]\n')
    expect(runQuarantineCheck([file], io, TODAY)).toBe(0)
    writeFileSync(file, JSON.stringify([entry({ added: '2026-09-01', expires: '2026-09-14' })]))
    expect(runQuarantineCheck([file], io, TODAY)).toBe(1)
    expect(lines.err.join('\n')).toMatch(/expired/)
  })
})
