import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { UiLogEntry } from './uiLogger'
import { installUiUncaughtHandlers, UI_UNCAUGHT_EXIT_CODE } from './uncaught'

// L1 (17 §1.1): Electron main's process-wide handler of 19 §9.1 `uncaught` and §11 (ADR-026 item 7;
// 13 FM-041). A fake process emitter stands in for `process`; the log's flush is held open by the
// test so the order "record, flush, then exit" is observable.

function uiMain() {
  const process = new EventEmitter()
  const entries: UiLogEntry[] = []
  let release: () => void = () => {}
  const log = {
    record: (entry: UiLogEntry) => void entries.push(entry),
    flush: (): Promise<void> =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  }
  const exits: number[] = []
  installUiUncaughtHandlers({ process, log, exit: (code) => exits.push(code) })
  return { process, entries, exits, release: () => release() }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('UI main uncaught handler (19 §9.1, §11; ADR-026 item 7; FM-041)', () => {
  it('[FM-041, ADR-026] an uncaught exception writes one uncaught record with its code and stack, flushes, then exits non-zero', async () => {
    const ui = uiMain()
    const error = Object.assign(new Error('the tray is gone'), { code: 'ERR_TRAY' })

    ui.process.emit('uncaughtException', error)

    expect(ui.entries).toEqual([
      {
        level: 'error',
        event: 'uncaught',
        subsystem: 'ui-main',
        errCode: 'ERR_TRAY',
        stack: error.stack
      }
    ])
    await settle()
    expect(ui.exits).toEqual([])
    ui.release()
    await settle()
    expect(ui.exits).toEqual([UI_UNCAUGHT_EXIT_CODE])
    expect(UI_UNCAUGHT_EXIT_CODE).not.toBe(0)
  })

  it('[FM-041, ADR-026] an unhandled rejection is the same record; a code the log would refuse falls back to the class name, a non-Error to unknown', async () => {
    const ui = uiMain()

    ui.process.emit(
      'unhandledRejection',
      Object.assign(new RangeError('out of range'), { code: 'not a code / with a path' })
    )
    ui.process.emit('unhandledRejection', { reason: 'a plain object' })

    expect(ui.entries).toEqual([
      expect.objectContaining({ event: 'uncaught', subsystem: 'ui-main', errCode: 'RangeError' }),
      { level: 'error', event: 'uncaught', subsystem: 'ui-main', errCode: 'unknown' }
    ])
    ui.release()
    await settle()
    expect(ui.exits).toEqual([UI_UNCAUGHT_EXIT_CODE])
  })

  it('[ADR-026] a listener on uncaughtException is registered, which is what keeps Electron from showing its error dialog', () => {
    const ui = uiMain()

    expect(ui.process.listenerCount('uncaughtException')).toBe(1)
    expect(ui.process.listenerCount('unhandledRejection')).toBe(1)
  })
})
