// The `SessionStarter` bridge (16 §4.5; 05 §3.5, as owner amendment N gives it its gate, AMENDMENT-14
// A14-02): launching → the suppliers driver's `launch` (ADR-009 D3) + ADR-020 classification. The
// edge launching → suppliers holds the types; the bridge lives in `host/wiring` because it reads the
// suppliers registry the composition root handed out (16 §8.3).
//
// - The driver: the first of `DriverRegistry.drivers(providerId)` (preference order, ADR-009 D4),
//   the same one launching detected through. None (a provider launch-gated in a public build,
//   ADR-009 D6) is `not-installed` (07 S5.16).
// - `req.onSpawned` is wrapped, never replaced: the spawn instant is `t0` of the early window, and
//   launching's own `onSpawned` writes the `processes` row before the handshake wait (16 §2.2).
// - A `DriverLaunchError` settles as its own cause (`launch()` rejects only with that, ADR-009 D3);
//   anything else a driver throws is `could-not-start` (a defect, never a sixth cause). The tail
//   is cut to the last 400 characters by `buildLaunchFailure` (ADR-020 item 6).
// - The handshake budget (S5.19): no readiness by `t0 + HANDSHAKE_TIMEOUT_MS` settles
//   `could-not-start`; a session the driver hands out after that is closed (`end-thread`), and its
//   identity-checked tree kill is the driver's (ADR-014; 15 §1.3).
// - The early window (S5.20, S5.21; NFR-TIM-06): once ready, the session must still be live at
//   `t0 + EARLY_FAILURE_WINDOW_MS`. The bridge cannot read the event stream (suppliers is its one
//   consumer, 15 §1.3, and holds a session's events until launching binds its dwarf), so it asks
//   `SessionChannels.sessionFor(ref)` at the window's end: a session that already exited is gone.
//   Its exit instant is then known only to lie between readiness and the window's end, which
//   `classifyLaunchOutcome` reads as `exited-at-once` (package gap, resolved in development: the
//   first-agent-event shortcut of ADR-020 D4 needs the stream, so the window always runs whole).
// - It settles exactly once.
// - `gate.launchedWithLetJevChoose` is for `DelegationLifecycle.issueFor`, whose call (and its
//   `revokeLaunch` on a failed start) is EPIC-12's (later: ISSUE-201…ISSUE-203). Until then every
//   session starts with the `delegation` launching built: `null`.
//
// Nothing here logs: a failure's tail is tool output (INV-55), and launching logs the cause.
import type { Instant, ProviderId } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { Scheduler } from '../../kernel/ports/scheduler'
import {
  buildLaunchFailure,
  classifyLaunchOutcome,
  EARLY_FAILURE_WINDOW_MS,
  HANDSHAKE_TIMEOUT_MS,
  NO_SUPPLIER_LABEL,
  type LaunchOutcomeEvent,
  type SessionStarter,
  type StartResult
} from '../../modules/launching'
import type {
  DriverLaunchError,
  DriverLaunchRequest,
  DriverRegistry,
  DriverSession,
  SessionChannels
} from '../../modules/suppliers'

export interface SessionStarterBridgeDeps {
  /** The suppliers registry whose sessions `sessions` tracks (`Suppliers.registry`). */
  registry: DriverRegistry
  /** Whether a session handed out is still live (`Suppliers.sessions`). */
  sessions: Pick<SessionChannels, 'sessionFor'>
  clock: Clock
  /** Runs the handshake budget and the early window. */
  scheduler: Scheduler
}

type Started = StartResult
type ProcessCause = 'not-installed' | 'could-not-start' | 'exited-at-once'

const CAUSES: readonly string[] = ['not-installed', 'could-not-start', 'exited-at-once']

/** `launch()` rejects only with a `DriverLaunchError` (ADR-009 D3); anything else is a defect. */
function isDriverLaunchError(error: unknown): error is DriverLaunchError {
  if (typeof error !== 'object' || error === null) return false
  const { cause } = error as { cause?: unknown }
  return typeof cause === 'string' && CAUSES.includes(cause)
}

export function createSessionStarter(deps: SessionStarterBridgeDeps): SessionStarter {
  const { clock, scheduler } = deps
  return {
    start: (providerId, req, gate) => {
      void gate // the delegation gate of issueFor (later: ISSUE-201…ISSUE-203)
      return startSession(providerId, req)
    }
  }

  function startSession(providerId: ProviderId, req: DriverLaunchRequest): Promise<Started> {
    const driver = deps.registry.drivers(providerId)[0]
    const label = driver?.profile.label ?? NO_SUPPLIER_LABEL
    const failed = (cause: ProcessCause, toolOutputTail?: string): Started => ({
      ok: false,
      error: buildLaunchFailure({
        cause,
        supplierLabel: label,
        ...(toolOutputTail === undefined ? {} : { toolOutputTail })
      })
    })
    if (driver === undefined) return Promise.resolve(failed('not-installed'))

    return new Promise<Started>((resolve) => {
      let settled = false
      let t0: Instant | null = null
      let handshakeTimer: { cancel(): void } | undefined
      const settle = (outcome: Started): void => {
        if (settled) return
        settled = true
        handshakeTimer?.cancel()
        resolve(outcome)
      }
      /** Settles from what was observed, at `now` (ADR-020 item 4). */
      const classify = (events: readonly LaunchOutcomeEvent[], session?: DriverSession): void => {
        const outcome = classifyLaunchOutcome(events, t0, clock.now())
        if (outcome.kind === 'pending') return
        if (outcome.kind === 'failed') settle(failed(outcome.cause))
        else if (session !== undefined) settle({ ok: true, value: session })
      }

      const wrapped: DriverLaunchRequest = {
        ...req,
        onSpawned: async (identity) => {
          if (t0 === null) {
            t0 = clock.now()
            handshakeTimer = scheduler.after(HANDSHAKE_TIMEOUT_MS, () => classify([]))
          }
          await req.onSpawned(identity)
        }
      }

      driver.launch(wrapped).then(
        (session) => {
          if (settled || t0 === null) {
            // Too late (the handshake budget ran out), or a driver that never reported its spawn
            // (15 §1.2: never skipped silently): the session is not the launch's.
            void session.close('end-thread')
            settle(failed('could-not-start'))
            return
          }
          handshakeTimer?.cancel()
          const readyAt = clock.now()
          const windowEnd = t0 + EARLY_FAILURE_WINDOW_MS
          const atWindowEnd = (): void => {
            const exited = deps.sessions.sessionFor(session.ref) === null
            const events: LaunchOutcomeEvent[] = [{ kind: 'ready', at: readyAt }]
            if (exited) events.push({ kind: 'ended', at: readyAt, how: 'exit' })
            classify(events, session)
          }
          if (readyAt >= windowEnd) atWindowEnd()
          else scheduler.after(windowEnd - readyAt, atWindowEnd)
        },
        (error: unknown) => {
          if (isDriverLaunchError(error)) settle(failed(error.cause, error.toolOutputTail))
          else settle(failed('could-not-start'))
        }
      )
    })
  }
}
