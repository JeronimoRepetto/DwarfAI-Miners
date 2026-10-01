// Renderer diagnostics (14 §1.10, A-N30 `reportRendererDiagnostic`; AMENDMENT-2, AR-13-03; 19 §2, §9.6; 18 T-45):
// the only path from a renderer to the log. A payload is `parse()`d with the strict `RendererDiagnostic` schema
// (allowlisted `event`, `errCode` code-name pattern, `count` 1..10 000, no other key); anything else is dropped and
// counted. A valid one is written through the UI logger as the 19 §9.6 record of its event, with `proc: 'ui'` (the
// logger's) and the sender window's mode in `msg`. Each window may log at most 30 records per minute; the excess,
// and the invalid payloads, are written once the minute has passed as one `renderer.diagnostic-dropped` record
// carrying their count. Nothing is ever forwarded to the Host.
import {
  rendererDiagnosticSchema,
  type LogLevel,
  type RendererDiagnostic
} from '@dwarfai/contracts'
import type { UiClock } from './ports/clock'
import type { UiLog, UiLogEntry } from './uiLogger'

/** The mode of the window that sent a diagnostic (ADR-024): the windows a renderer runs in. */
export type DiagnosticWindowMode = 'panel' | 'veta' | 'valle'

/** 14 §1.10: at most this many records per window per minute. */
export const RENDERER_RECORDS_PER_MINUTE = 30
const MINUTE_MS = 60_000

/** 19 §9.6: the level of each allowlisted event. */
const LEVEL: Readonly<Record<RendererDiagnostic['event'], LogLevel>> = {
  'renderer.error': 'error',
  'renderer.unhandled-rejection': 'error',
  'renderer.store-error': 'warn'
}

/** The module that owns renderer windows and writes their records (05 §3.14). */
const SUBSYSTEM = 'window'

export interface RendererDiagnosticsDeps {
  readonly log: UiLog
  readonly clock: UiClock
  /** The mode of a registered mode window, by its `webContents` id; `undefined` for any other sender. */
  modeOf(webContentsId: number): DiagnosticWindowMode | undefined
}

export interface RendererDiagnosticCounters {
  /** Records handed to the UI logger. */
  readonly logged: number
  /** Payloads the strict schema refused. */
  readonly invalid: number
  /** Payloads from a sender that is no mode window (so there is no mode to log). */
  readonly unknownSender: number
  /** Records over a window's 30-per-minute limit. */
  readonly rateLimited: number
}

export interface RendererDiagnostics {
  /** One A-N30 call from the window whose `webContents` id is given. Never throws. */
  report(webContentsId: number | undefined, payload: unknown): void
  counters(): RendererDiagnosticCounters
}

/** One window's current minute. */
interface WindowMinute {
  readonly openedAt: number
  readonly mode: DiagnosticWindowMode
  logged: number
  rateLimited: number
  invalid: number
}

export function createRendererDiagnostics(deps: RendererDiagnosticsDeps): RendererDiagnostics {
  const minutes = new Map<number, WindowMinute>()
  const counters = { logged: 0, invalid: 0, unknownSender: 0, rateLimited: 0 }

  /** 19 §9.6 `renderer.diagnostic-dropped`: what a passed minute refused, one record per cause. */
  function closePassedMinutes(now: number): void {
    for (const [id, minute] of minutes) {
      if (now - minute.openedAt < MINUTE_MS) continue
      minutes.delete(id)
      if (minute.invalid > 0) dropped(minute.mode, 'invalid-payload', minute.invalid)
      if (minute.rateLimited > 0) dropped(minute.mode, 'rate-limited', minute.rateLimited)
    }
  }

  function dropped(mode: DiagnosticWindowMode, causeClass: string, count: number): void {
    deps.log.record({
      level: 'warn',
      event: 'renderer.diagnostic-dropped',
      subsystem: SUBSYSTEM,
      causeClass,
      count,
      msg: mode
    })
  }

  function minuteOf(id: number, mode: DiagnosticWindowMode, now: number): WindowMinute {
    let minute = minutes.get(id)
    if (minute === undefined) {
      minute = { openedAt: now, mode, logged: 0, rateLimited: 0, invalid: 0 }
      minutes.set(id, minute)
    }
    return minute
  }

  function accept(webContentsId: number | undefined, payload: unknown): void {
    const now = deps.clock.now()
    closePassedMinutes(now)
    const mode = webContentsId === undefined ? undefined : deps.modeOf(webContentsId)
    if (webContentsId === undefined || mode === undefined) {
      counters.unknownSender += 1
      return
    }
    const minute = minuteOf(webContentsId, mode, now)
    const parsed = rendererDiagnosticSchema.safeParse(payload)
    if (!parsed.success) {
      counters.invalid += 1
      minute.invalid += 1
      return
    }
    if (minute.logged >= RENDERER_RECORDS_PER_MINUTE) {
      counters.rateLimited += 1
      minute.rateLimited += 1
      return
    }
    minute.logged += 1
    counters.logged += 1
    const { event, errCode, count } = parsed.data
    const entry: UiLogEntry = { level: LEVEL[event], event, subsystem: SUBSYSTEM, msg: mode }
    if (errCode !== undefined) entry.errCode = errCode
    if (count !== undefined) entry.count = count
    deps.log.record(entry)
  }

  return {
    report(webContentsId, payload) {
      try {
        accept(webContentsId, payload)
      } catch {
        // A renderer's report never breaks Electron main; the UI logger counts its own failures.
        counters.invalid += 1
      }
    },
    counters: () => ({ ...counters })
  }
}
