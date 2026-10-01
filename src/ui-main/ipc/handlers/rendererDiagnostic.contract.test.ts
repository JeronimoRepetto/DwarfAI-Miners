// layer: L6
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { CHANNELS, type ChannelSpec } from '@dwarfai/contracts'
import { FakeClock } from '../../diagnostics/ports/fakes/FakeClock'
import { FakeLogFiles } from '../../diagnostics/ports/fakes/FakeLogFiles'
import {
  createRendererDiagnostics,
  type DiagnosticWindowMode
} from '../../diagnostics/rendererDiagnostics'
import { createUiLogger, type UiLog, type UiLogEntry } from '../../diagnostics/uiLogger'
import type { ChannelOwner, ChannelRoute } from '../channelRoute'
import { createRouter, type RouteTarget } from '../router'
import type { IpcSenderEvent, SenderPolicy } from '../senderCheck'
import { createRendererDiagnosticHandler } from './rendererDiagnostic'

/**
 * A-N30 `reportRendererDiagnostic` (14 §1.10, §2.2, §3.8; AMENDMENT-2, AR-13-03; 19 §9.6; 18 T-45): the only path
 * from a renderer to the log. The route here is the one ISSUE-056 gives the row in cut 0, built from the registry's
 * own placement, so the case proves where the registry sends it, not where the test does.
 */
const CHANNEL = 'diag:renderer:report'
const LOG_DIR = join('/', 'user-data', 'logs')
const START = Date.parse('2026-10-01T09:00:00.000Z')
const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const VETA_ID = 8
const MODES: Readonly<Record<number, DiagnosticWindowMode>> = {
  [PANEL_ID]: 'panel',
  [VETA_ID]: 'veta'
}
const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id in MODES }
const from = (id: number): IpcSenderEvent => ({ sender: { id }, senderFrame: { url: APP_ENTRY } })

/** The owner a route of this placement has: the route follows whatever the registry declares. */
const ownerOf = (placement: ChannelSpec<z.ZodTypeAny, z.ZodTypeAny>['placement']): ChannelOwner =>
  placement === 'host' ? 'host' : 'ui-local'

class RecordingUiLog implements UiLog {
  readonly entries: UiLogEntry[] = []
  record(entry: UiLogEntry): void {
    this.entries.push(entry)
  }
}

function recordingTarget() {
  const served: [string, unknown][] = []
  const target: RouteTarget = {
    async serve(channel, payload) {
      served.push([channel, payload])
      return undefined
    }
  }
  return { target, served }
}

function handlerOver(log: UiLog, clock: FakeClock) {
  const diagnostics = createRendererDiagnostics({
    log,
    clock,
    modeOf: (id) => MODES[id]
  })
  return { diagnostics, handler: createRendererDiagnosticHandler(diagnostics) }
}

describe('A-N30 reportRendererDiagnostic (14 §1.10)', () => {
  it('[ADR-026] a valid renderer diagnostic becomes one UI log record with the window mode and nothing reaches the Host', async () => {
    const files = new FakeLogFiles()
    const clock = new FakeClock(START)
    const log = createUiLogger({
      files,
      logDir: LOG_DIR,
      clock,
      appVersion: '0.20.0',
      pid: 4242,
      level: 'info'
    })
    const { handler } = handlerOver(log, clock)
    const host = recordingTarget()
    const legacy = recordingTarget()
    const route: ChannelRoute = {
      channel: CHANNEL,
      owner: ownerOf(CHANNELS[CHANNEL].placement),
      since: 'cut-0',
      parity: 'n/a',
      shape: 'target'
    }
    const router = createRouter({
      routes: [route],
      legacy: legacy.target,
      host: host.target,
      uiLocal: handler,
      senders
    })

    const answer = await router.dispatch(CHANNEL, from(PANEL_ID), {
      event: 'renderer.error',
      errCode: 'TypeError',
      count: 3
    })
    await log.flush()

    expect(answer).toBeUndefined()
    const lines = (files.textOf(join(LOG_DIR, 'ui-000001.jsonl')) ?? '')
      .trimEnd()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toEqual([
      {
        ts: '2026-10-01T09:00:00.000Z',
        level: 'error',
        proc: 'ui',
        pid: 4242,
        appVersion: '0.20.0',
        event: 'renderer.error',
        subsystem: 'window',
        errCode: 'TypeError',
        msg: 'panel',
        count: 3
      }
    ])
    // Never forwarded to the Host (14 §1.10), and today's runtime never sees it either.
    expect(host.served).toEqual([])
    expect(legacy.served).toEqual([])
  })

  it('[ADR-026] an extra key, a free-text field or an unknown event is dropped and counted', async () => {
    const clock = new FakeClock(START)
    const log = new RecordingUiLog()
    const { diagnostics, handler } = handlerOver(log, clock)
    const invalid: unknown[] = [
      { event: 'renderer.error', message: 'Cannot read properties of undefined' }, // an extra key
      { event: 'renderer.error', stack: 'TypeError: x\n    at f (app.js:1:1)' }, // an extra key
      { event: 'renderer.error', errCode: 'Cannot read properties of undefined' }, // free text in errCode
      { event: 'renderer.error', errCode: 'C:\\Users\\canary.user\\notes.txt' }, // a path in errCode
      { event: 'renderer.crashed' }, // an event outside the allowlist
      { event: 'renderer.error', count: 0 }, // count below 1
      { event: 'renderer.error', count: 10_001 }, // count above 10 000
      { event: 'renderer.error', count: 1.5 }, // count not an integer
      'renderer.error', // not an object
      undefined
    ]
    for (const payload of invalid) {
      expect(await handler.serve(CHANNEL, payload, from(PANEL_ID))).toBeUndefined()
    }
    // A valid payload whose sender is not a mode window has no mode to log: dropped and counted too.
    await handler.serve(CHANNEL, { event: 'renderer.error' }, from(99))
    await handler.serve(CHANNEL, { event: 'renderer.error' })

    expect(log.entries).toEqual([])
    expect(diagnostics.counters()).toEqual({
      logged: 0,
      invalid: 10,
      unknownSender: 2,
      rateLimited: 0
    })
    // 19 §9.6 `renderer.diagnostic-dropped`: once the minute has passed, the next report carries the count.
    clock.advance(60_001)
    await handler.serve(CHANNEL, { event: 'renderer.store-error' }, from(PANEL_ID))
    expect(log.entries).toEqual([
      {
        level: 'warn',
        event: 'renderer.diagnostic-dropped',
        subsystem: 'window',
        causeClass: 'invalid-payload',
        count: 10,
        msg: 'panel'
      },
      { level: 'warn', event: 'renderer.store-error', subsystem: 'window', msg: 'panel' }
    ])

    // Through the router, the seam A gate refuses the same payloads before any handler runs (ISSUE-044).
    const router = createRouter({
      routes: [
        { channel: CHANNEL, owner: 'ui-local', since: 'cut-0', parity: 'n/a', shape: 'target' }
      ],
      legacy: recordingTarget().target,
      uiLocal: handler,
      senders
    })
    for (const payload of invalid) await router.dispatch(CHANNEL, from(PANEL_ID), payload)
    expect(router.refusalCount(CHANNEL, 'INVALID_PARAMS')).toBe(invalid.length)
    expect(log.entries).toHaveLength(2)
  })

  it('[ADR-026] the 31st record in a minute from one window is folded into one count', async () => {
    const clock = new FakeClock(START)
    const log = new RecordingUiLog()
    const { diagnostics, handler } = handlerOver(log, clock)
    for (let i = 0; i < 34; i += 1) {
      clock.advance(1_000)
      await handler.serve(
        CHANNEL,
        { event: 'renderer.unhandled-rejection', errCode: 'AbortError' },
        from(PANEL_ID)
      )
    }
    // Another window has its own limit in the same minute.
    await handler.serve(CHANNEL, { event: 'renderer.error', errCode: 'RangeError' }, from(VETA_ID))

    const fromPanel = log.entries.filter((e) => e.msg === 'panel')
    expect(fromPanel).toHaveLength(30)
    expect(fromPanel.every((e) => e.event === 'renderer.unhandled-rejection')).toBe(true)
    expect(log.entries.filter((e) => e.msg === 'veta')).toEqual([
      {
        level: 'error',
        event: 'renderer.error',
        subsystem: 'window',
        errCode: 'RangeError',
        msg: 'veta'
      }
    ])
    expect(diagnostics.counters()).toMatchObject({ logged: 31, rateLimited: 4 })

    // The excess of the minute is one record carrying its count, written when the minute has passed.
    clock.advance(60_000)
    await handler.serve(CHANNEL, { event: 'renderer.error', errCode: 'TypeError' }, from(PANEL_ID))
    expect(log.entries.slice(-2)).toEqual([
      {
        level: 'warn',
        event: 'renderer.diagnostic-dropped',
        subsystem: 'window',
        causeClass: 'rate-limited',
        count: 4,
        msg: 'panel'
      },
      {
        level: 'error',
        event: 'renderer.error',
        subsystem: 'window',
        errCode: 'TypeError',
        msg: 'panel'
      }
    ])
  })
})
