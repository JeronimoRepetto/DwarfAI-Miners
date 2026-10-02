import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { installUncaughtHandlers, UNCAUGHT_EXIT_CODE } from './uncaught'

// L1 (17 §1.1): the Host's process-wide handler of 19 §9.1 `uncaught` and §11 (ADR-026 item 7;
// 13 FM-001). A fake process emitter stands in for `process`; the log's flush is held open by the
// test so the order "record, flush, then exit" is observable.

function host() {
  const process = new EventEmitter()
  const log = new RecordingDiagnosticsLog()
  let release: () => void = () => {}
  const flushes: Array<Promise<void>> = []
  const flushing = Object.assign(log, {
    flush: (): Promise<void> => {
      const flushed = new Promise<void>((resolve) => {
        release = resolve
      })
      flushes.push(flushed)
      return flushed
    }
  })
  const exits: number[] = []
  installUncaughtHandlers({ process, log: flushing, exit: (code) => exits.push(code) })
  return { process, log, exits, flushes, release: () => release() }
}

/** Lets the handler's promise chain run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('Host uncaught handler (19 §9.1, §11; ADR-026 item 7; FM-001)', () => {
  it('[FM-001, ADR-026] an uncaught exception writes one uncaught record with its code and stack, flushes, then exits non-zero', async () => {
    const h = host()
    const error = Object.assign(new Error('the journal is gone'), { code: 'EIO' })

    h.process.emit('uncaughtException', error)

    expect(h.log.entries).toEqual([
      {
        level: 'error',
        event: 'uncaught',
        subsystem: 'host',
        errCode: 'EIO',
        stack: error.stack
      }
    ])
    await settle()
    // Nothing ends the Host before the record reached the segment.
    expect(h.exits).toEqual([])
    h.release()
    await settle()
    expect(h.exits).toEqual([UNCAUGHT_EXIT_CODE])
    expect(UNCAUGHT_EXIT_CODE).not.toBe(0)
  })

  it('[FM-001, ADR-026] an unhandled rejection is the same uncaught record; a reason that is not an Error has no stack', async () => {
    const h = host()

    h.process.emit('unhandledRejection', new TypeError('x is not a function'))
    h.process.emit('unhandledRejection', 'a bare string reason')

    expect(h.log.entries).toEqual([
      expect.objectContaining({ event: 'uncaught', errCode: 'TypeError' }),
      { level: 'error', event: 'uncaught', subsystem: 'host', errCode: 'unknown' }
    ])
    expect(JSON.stringify(h.log.entries)).not.toContain('a bare string reason')
    h.release()
    await settle()
    // One exit, however many errors arrived while the first was being flushed.
    expect(h.exits).toEqual([UNCAUGHT_EXIT_CODE])
  })

  it('[ADR-026] the handler listens to both process events, so Node never prints and exits on its own first', () => {
    const h = host()

    expect(h.process.listenerCount('uncaughtException')).toBe(1)
    expect(h.process.listenerCount('unhandledRejection')).toBe(1)
  })
})
