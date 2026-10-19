/**
 * Log redaction canary, Host writer half (17 §1.7 "Log redaction canary", ADR-026 Verification,
 * 18 C-27). The pure half (contracts/logging/canary.test.ts) proves the shaped fields, `stack` and
 * the recognisable values in `msg`/`errCode`; this half seeds CANARY_CORPUS through the Host's
 * logging entry point (`createDiagnostics(...).record`) over a real temporary `logs/` folder and
 * reads back every segment written.
 *
 * What stays with the emitting modules: `msg` is "a fixed developer sentence" (ADR-026 item 3) and
 * `DiagnosticEntry.msg` is a plain `string` (16 §3, frozen), so plain words in `msg` (a name, a
 * prompt) cannot be told from a sentence by any writer rule. The Host rules refuse the shapes that
 * never belong in a sentence (line breaks, quotes, brackets, paths); every other content value is
 * kept out of `msg` by the module that emits the record, proven by that module's canary over its
 * own inputs.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CANARY_CORPUS, CANARY_HOME_NAMES } from '../../../contracts/logging/testing/canaryCorpus'
import { HostInvariantError } from '../../kernel/domain/errors'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import type { DiagnosticEntry } from '../../kernel/ports/diagnosticsLog'
import { NodeFs } from '../../platform/fs/NodeFs'
import { HostDiagnosticsLog } from './adapters/HostDiagnosticsLog'
import { createDiagnostics } from './index'

const APP_ROOT = join(tmpdir(), 'dwarfai-app-root')
const START = Date.parse('2026-10-02T09:00:00.000Z')
const DWARF = '0192f0c1-7a2e-7c3d-9f00-5b1a2c3d4e5f'

/** Every field a caller can put in an entry: the `LogRecord` fields, writer-filled ones included. */
const ENTRY_FIELDS = [
  'ts',
  'level',
  'proc',
  'pid',
  'appVersion',
  'event',
  'subsystem',
  'outcome',
  'causeClass',
  'provider',
  'providerVersion',
  'dwarfId',
  'mineId',
  'launchId',
  'errCode',
  'msg',
  'count',
  'requestId',
  'hostEpoch',
  'askId',
  'messageId',
  'delegationId',
  'resetId',
  'connId',
  'role',
  'method',
  'seq',
  'bytes',
  'durationMs',
  'stack'
] as const

/** The correlation and transport fields (ADR-026 item 3, CR-13-04 / CR-19-01). */
const CORRELATION_FIELDS = [
  'requestId',
  'hostEpoch',
  'askId',
  'messageId',
  'delegationId',
  'resetId',
  'connId',
  'role',
  'method',
  'seq',
  'bytes',
  'durationMs'
] as const

describe('log redaction canary, Host writer (17 §1.7)', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('[NFR-SEC-12, NFR-OBS-02] no value of the canary corpus reaches a Host segment through record, through an error stack or through any correlation field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dwarfai-canary-'))
    roots.push(root)
    const logDir = join(root, 'logs')
    const clock = new FakeClock(START)
    const log = createDiagnostics({
      fs: new NodeFs(),
      clock,
      logDir,
      appVersion: '0.20.0',
      level: 'debug',
      appRoot: APP_ROOT
    })
    expect(log).toBeInstanceOf(HostDiagnosticsLog)
    // Through the writer-filled appVersion: the composition root cannot build a log around it.
    for (const { kind, value } of CANARY_CORPUS) {
      expect(
        () =>
          createDiagnostics({ fs: new NodeFs(), clock, logDir, appVersion: value, level: 'info' }),
        kind
      ).toThrow(HostInvariantError)
    }
    // Each seeded record has its own dwarf-free key and time, so none is folded away unseen.
    let n = 0
    const record = (entry: Record<string, unknown>): void => {
      clock.advance(60_001)
      n += 1
      log.record({
        level: 'warn',
        event: 'canary.probe',
        subsystem: 'launching',
        errCode: `E${n}`,
        ...entry
      } as DiagnosticEntry)
    }

    for (const { value } of CANARY_CORPUS) {
      // Through record: the value in each field on its own.
      for (const field of ENTRY_FIELDS) {
        if (field === 'msg') continue
        record({ [field]: value })
        record({ [field]: `step failed near ${value} and stopped` })
      }
      // Through an error stack: a DwarfAI error whose message holds the value.
      record({
        level: 'error',
        event: 'uncaught',
        stack: `Error: ${value}\n    at spawnDriver (${join(APP_ROOT, 'out', 'host', 'main.js')}:10:5)`
      })
      // Through every correlation field at once, next to a valid dwarf id.
      record(Object.fromEntries([['dwarfId', DWARF], ...CORRELATION_FIELDS.map((f) => [f, value])]))
    }
    // Through msg: the recognisable values and every value with a shape no sentence has.
    for (const { class: kind, value } of CANARY_CORPUS) {
      if (kind !== 'content' || /[\r\n\\/"`{}[\]]/.test(value)) {
        record({ msg: value })
        record({ msg: `step failed near ${value} and stopped` })
      }
    }
    // A clean record, so something is written and the folder is read back for real.
    record({ level: 'info', event: 'host.start', subsystem: 'host', msg: 'boot sequence started' })
    await (log as HostDiagnosticsLog).flush()

    const names = await readdir(logDir)
    expect(names.length).toBeGreaterThan(0)
    const output = (
      await Promise.all(names.map((name) => readFile(join(logDir, name), 'utf8')))
    ).join('')
    expect(output).toContain('"event":"host.start"')
    expect(output).toContain('spawnDriver (out/host/main.js:10:5)')
    for (const { kind, value } of CANARY_CORPUS) {
      expect(output, kind).not.toContain(value)
      // A JSON line escapes backslashes, quotes and line ends: check the escaped form too.
      expect(output, kind).not.toContain(JSON.stringify(value).slice(1, -1))
    }
    for (const name of CANARY_HOME_NAMES) expect(output, name).not.toContain(name)
  })
})
