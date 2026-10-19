import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkOsLaneReport, runOsLaneGuard } from './os-lane-guard.mjs'

/**
 * L7 check of the OS-lane empty guard (testing strategy `17` §1.8, HO-38).
 *
 * `pnpm test:os` writes a Vitest JSON report; the guard reads it and fails the OS job when no test
 * executed. A test that `describe.runIf` turned off is reported as skipped, never as executed, so a
 * mistyped platform guard cannot turn a lane into a silent pass.
 */

/** A Vitest JSON report holding one test file with tests of the given statuses. */
function report(statuses) {
  return {
    numTotalTests: statuses.length,
    testResults: [
      {
        name: 'src/contracts/__os_smoke__.os.test.ts',
        assertionResults: statuses.map((status, index) => ({
          fullName: `test ${index}`,
          status
        }))
      }
    ]
  }
}

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

function collectingIo() {
  const lines = { out: [], err: [] }
  return {
    lines,
    io: { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) }
  }
}

describe('OS-lane empty guard (17 §1.8)', () => {
  it('[ADR-004] an OS-lane report with zero executed tests fails the guard; one or more passes', () => {
    expect(checkOsLaneReport(report([])).ok, 'a report with no tests').toBe(false)
    expect(checkOsLaneReport(report(['skipped', 'skipped'])).ok, 'only skipped tests').toBe(false)
    expect(checkOsLaneReport(report(['todo', 'pending'])).ok, 'only todo and pending').toBe(false)
    expect(checkOsLaneReport(report(['skipped', 'passed'])).ok, 'one passed test').toBe(true)
    expect(checkOsLaneReport(report(['passed', 'passed'])).executed).toBe(2)
    expect(checkOsLaneReport(report(['failed'])).ok, 'a failed test still executed').toBe(true)
  })

  it('[ADR-004] a missing or unreadable OS-lane report fails the guard', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'os-lane-guard-'))
    tempRoots.push(dir)
    const missing = collectingIo()
    expect(runOsLaneGuard([path.join(dir, 'absent.json')], missing.io)).toBe(1)
    expect(missing.lines.err.join('\n')).toMatch(/report not found/)

    const broken = path.join(dir, 'broken.json')
    writeFileSync(broken, '{ not json')
    const unreadable = collectingIo()
    expect(runOsLaneGuard([broken], unreadable.io)).toBe(1)
    expect(unreadable.lines.err.join('\n')).toMatch(/not valid JSON/)

    const good = path.join(dir, 'good.json')
    writeFileSync(good, JSON.stringify(report(['passed'])))
    const passing = collectingIo()
    expect(runOsLaneGuard([good], passing.io)).toBe(0)
    expect(passing.lines.out.join('\n')).toMatch(/1 test\(s\) executed/)
  })
})
