/**
 * Log redaction canary, pure half (17 §1.7 "Log redaction canary", ADR-026 Verification, 18 C-27).
 *
 * The split between this pure half and the writers' canaries (owner ruling, recorded in ISSUE-012):
 * - Pure half (this file) guarantees that no corpus value reaches a line through
 *   - every shaped field: the UUIDv7 ids, `ts`, the closed unions, the numbers, `event` (stable dotted
 *     id) and `provider` (catalog id), citations in `logRecord.ts`;
 *   - `stack`, whose message lines are dropped;
 *   - `msg` and `errCode` for `credential` and `home-path` values, which redaction removes.
 * - Writers (Host, UI main, shims) keep `content` values out of the free-string fields: `msg`
 *   sentences, `errCode`, `appVersion`, `subsystem`, `causeClass`, `providerVersion`, `method`,
 *   `hostEpoch`, `connId`. Their owners declare a plain `string`, so no pure rule can recognise a name
 *   or a prompt in them; each writer's canary seeds `CANARY_CORPUS` through its real inputs (17 §1.7),
 *   which is where ADR-026 item 3 "msg: fixed developer sentence" is enforced.
 */
import { describe, expect, it } from 'vitest'
import type { LogRecord } from './logRecord'
import { CANARY_CORPUS, CANARY_HOME_NAMES } from './testing/canaryCorpus'
import { toLogLine } from './toLogLine'

const base: LogRecord = {
  ts: '2026-10-02T09:14:03.120Z',
  level: 'error',
  proc: 'host',
  pid: 18344,
  appVersion: '0.20.0',
  event: 'launch.failed',
  subsystem: 'launching'
}

/** Every field whose owner declares a shape narrower than free text (citations in `logRecord.ts`). */
const SHAPED_FIELDS = [
  'ts',
  'level',
  'proc',
  'pid',
  'event',
  'outcome',
  'provider',
  'dwarfId',
  'mineId',
  'launchId',
  'count',
  'requestId',
  'askId',
  'messageId',
  'delegationId',
  'resetId',
  'role',
  'seq',
  'bytes',
  'durationMs'
] as const

/** What a writer would write for `r`: the line, or nothing when the record is refused. */
function written(r: Record<string, unknown>): string {
  const out = toLogLine(r as unknown as LogRecord)
  return typeof out === 'string' ? out : ''
}

function expectAbsent(output: string, value: string, where: string): void {
  expect(output, where).not.toContain(value)
  // A JSON line escapes backslashes, quotes and line ends: check the escaped form too.
  expect(output, where).not.toContain(JSON.stringify(value).slice(1, -1))
  for (const name of CANARY_HOME_NAMES) expect(output, where).not.toContain(name)
}

describe('log redaction canary, pure half (17 §1.7)', () => {
  it('[NFR-SEC-12, NFR-OBS-02] no corpus value appears in any line produced from any LogRecord field', () => {
    for (const { kind, value } of CANARY_CORPUS) {
      for (const field of SHAPED_FIELDS) {
        expectAbsent(written({ ...base, [field]: value }), value, `${kind} in ${field}`)
      }

      const output = written({
        ...base,
        stack: `Error: ${value}\n    at spawnDriver (out/main/index.js:10:5)`
      })
      expect(output, `${kind} in stack`).toContain('spawnDriver')
      expectAbsent(output, value, `${kind} in stack`)
    }

    const recognisable = CANARY_CORPUS.filter((c) => c.class !== 'content')
    expect(recognisable.length).toBeGreaterThan(0)
    for (const { kind, value } of recognisable) {
      for (const field of ['msg', 'errCode'] as const) {
        const output = written({ ...base, [field]: `step failed near ${value} and stopped` })
        expect(output, `${kind} in ${field}`).toContain('step failed near')
        expectAbsent(output, value, `${kind} in ${field}`)
      }
    }
  })
})
