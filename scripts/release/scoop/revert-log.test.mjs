// layer: L7
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRevertEntries } from './revert-log.mjs'

// The Windows package leg's Scoop check (scoop-check.ps1) proves which Scoop step ran `--revert-integrations` by the
// `host.revert-integrations` records the UI writes into its log segments (hostLauncher/revertIntegrations.ts; 19 §2),
// counted before and after each step.

const line = (record) =>
  `${JSON.stringify({ ts: '2026-10-24T00:00:00.000Z', proc: 'ui', ...record })}\n`

let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'scoop-revert-log-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Scoop check revert records', () => {
  it('[ADR-016, FM-128] counts the host.revert-integrations records of every ui segment with their outcome', () => {
    writeFileSync(
      path.join(dir, 'ui-000001.jsonl'),
      line({ event: 'app.started', outcome: 'ok' }) +
        line({ event: 'host.revert-integrations', outcome: 'ok' }) +
        'not json\n'
    )
    writeFileSync(
      path.join(dir, 'ui-000002.jsonl'),
      line({ event: 'host.revert-integrations', outcome: 'failed', errCode: 'HOST_EXIT_65' })
    )
    writeFileSync(
      path.join(dir, 'host-000001.jsonl'),
      line({ event: 'host.revert-integrations', outcome: 'ok' })
    )
    mkdirSync(path.join(dir, 'ui-000003.jsonl'))

    expect(readRevertEntries(dir)).toEqual([
      { outcome: 'ok', errCode: null },
      { outcome: 'failed', errCode: 'HOST_EXIT_65' }
    ])
  })

  it('[ADR-016, FM-128] a missing log folder holds no revert record', () => {
    expect(readRevertEntries(path.join(dir, 'absent'))).toEqual([])
  })
})
