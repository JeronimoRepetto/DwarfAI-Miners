/**
 * Log redaction canary, UI writer half (17 §1.7 "Log redaction canary", ADR-026 Verification, 18 C-27). The pure
 * half (contracts/logging/canary.test.ts) proves the shaped fields, `stack` and the recognisable values in
 * `msg`/`errCode`; this half seeds CANARY_CORPUS through every logging entry point of Electron main — the UI
 * logger's `record`, an uncaught error's stack and the renderer diagnostics of A-N30 — over a real temporary
 * `logs/` folder, and reads back every segment written.
 *
 * What stays with the emitting code: `msg` is "a fixed developer sentence" (ADR-026 item 3), so plain words in it (a
 * name, a prompt) cannot be told from a sentence by any writer rule. The UI rules refuse the shapes that never
 * belong in a sentence (line breaks, quotes, brackets, paths); A-N30 never lets a renderer reach `msg` at all (main
 * writes the sender window's mode there).
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CANARY_CORPUS, CANARY_HOME_NAMES } from '../../contracts/logging/testing/canaryCorpus'
import { createRendererDiagnosticHandler } from '../ipc/handlers/rendererDiagnostic'
import type { IpcSenderEvent } from '../ipc/senderCheck'
import { NodeLogFiles } from './adapters/NodeLogFiles'
import { FakeClock } from './ports/fakes/FakeClock'
import { createRendererDiagnostics } from './rendererDiagnostics'
import { createUiLogger, type UiLogEntry } from './uiLogger'

const APP_ROOT = join(tmpdir(), 'dwarfai-app-root')
const START = Date.parse('2026-10-02T09:00:00.000Z')
const DWARF = '0192f0c1-7a2e-7c3d-9f00-5b1a2c3d4e5f'
const PANEL_ID = 3
const FROM_PANEL: IpcSenderEvent = {
  sender: { id: PANEL_ID },
  senderFrame: { url: 'file:///app/out/renderer/index.html' }
}

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

describe('log redaction canary, UI writer (17 §1.7)', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('[NFR-SEC-12] no value of the canary corpus reaches a UI segment through record, an error stack or A-N30', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dwarfai-ui-canary-'))
    roots.push(root)
    const logDir = join(root, 'logs')
    const clock = new FakeClock(START)
    const files = new NodeLogFiles()
    const log = createUiLogger({
      files,
      logDir,
      clock,
      appVersion: '0.20.0',
      pid: 4242,
      level: 'debug',
      appRoot: APP_ROOT
    })
    // Through the writer-filled appVersion: the composition root cannot build a logger around it.
    for (const { kind, value } of CANARY_CORPUS) {
      expect(
        () => createUiLogger({ files, logDir, clock, appVersion: value, pid: 1, level: 'info' }),
        kind
      ).toThrow(TypeError)
    }
    // Each seeded record has its own time, so none is folded away unseen.
    let n = 0
    const record = (entry: Record<string, unknown>): void => {
      clock.advance(60_001)
      n += 1
      log.record({
        level: 'warn',
        event: 'canary.probe',
        subsystem: 'window',
        errCode: `E${n}`,
        ...entry
      } as UiLogEntry)
    }

    for (const { value } of CANARY_CORPUS) {
      // Through record: the value in each field on its own, and inside a sentence.
      for (const field of ENTRY_FIELDS) {
        if (field === 'msg') continue
        record({ [field]: value })
        record({ [field]: `step failed near ${value} and stopped` })
      }
      // Through an error stack: an uncaught error of Electron main whose message holds the value.
      record({
        level: 'error',
        event: 'uncaught',
        stack: `Error: ${value}\n    at layoutPanel (${join(APP_ROOT, 'out', 'main', 'index.js')}:10:5)`
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

    // Through A-N30: the value in every renderer field, as an extra key and as an extra key's name.
    const diagnostics = createRendererDiagnostics({
      log,
      clock,
      modeOf: (id) => (id === PANEL_ID ? 'panel' : undefined)
    })
    const handler = createRendererDiagnosticHandler(diagnostics)
    const report = async (payload: unknown): Promise<void> => {
      clock.advance(60_001)
      await handler.serve('diag:renderer:report', payload, FROM_PANEL)
    }
    for (const { value } of CANARY_CORPUS) {
      await report({ event: value })
      await report({ event: 'renderer.error', errCode: value })
      await report({ event: 'renderer.error', count: value })
      await report({ event: 'renderer.error', message: value })
      await report({ event: 'renderer.error', stack: `Error: ${value}\n    at f (app.js:1:1)` })
      await report({ event: 'renderer.error', [value]: 1 })
      await report(value)
    }
    // A clean record of each kind, so something is written and the folder is read back for real.
    record({ level: 'info', event: 'tray.state', subsystem: 'window', outcome: 'ok' })
    await report({ event: 'renderer.error', errCode: 'TypeError', count: 2 })
    clock.advance(60_001)
    await report({ event: 'renderer.store-error' })
    await log.flush()

    const names = await readdir(logDir)
    expect(names.length).toBeGreaterThan(0)
    const output = (
      await Promise.all(names.map((name) => readFile(join(logDir, name), 'utf8')))
    ).join('')
    expect(output).toContain('"event":"tray.state"')
    expect(output).toContain('layoutPanel (out/main/index.js:10:5)')
    expect(output).toContain('"event":"renderer.error","subsystem":"window","errCode":"TypeError"')
    expect(output).toContain('"event":"renderer.diagnostic-dropped"')
    for (const { kind, value } of CANARY_CORPUS) {
      expect(output, kind).not.toContain(value)
      // A JSON line escapes backslashes, quotes and line ends: check the escaped form too.
      expect(output, kind).not.toContain(JSON.stringify(value).slice(1, -1))
    }
    for (const name of CANARY_HOME_NAMES) expect(output, name).not.toContain(name)
  })
})
