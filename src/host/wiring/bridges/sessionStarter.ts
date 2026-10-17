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
// - A session handed out to a launch that then fails is never bound to a dwarf, so it is released
//   to suppliers unbound (GitHub #1316): the late session above, and the one that exited inside
//   the early window. Otherwise suppliers would hold its entry and events for the Host's life.
// - It settles exactly once.
// - A timed check (the handshake budget, the window's end) that runs before `clock.now()` reaches
//   its deadline finds the outcome `pending` and is armed again for the time left (at least 1 ms):
//   the scheduler's timers and the clock need not agree to the millisecond (a monotonic timer can
//   fire before the wall clock reaches the deadline).
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
  SessionChannels,
  SessionReleases
} from '../../modules/suppliers'

export interface SessionStarterBridgeDeps {
  /** The suppliers registry whose sessions `sessions` tracks (`Suppliers.registry`). */
  registry: DriverRegistry
  /** Whether a session handed out is still live (`Suppliers.sessions`). */
  sessions: Pick<SessionChannels, 'sessionFor'>
  /**
   * Where a session handed out to a launch that then failed is released unbound (GitHub #1316,
   * `Suppliers.releases`). Absent in compositions that never read the suppliers index.
   */
  releases?: Pick<SessionReleases, 'release'>
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
      /** Settles from what was observed, at `now` (ADR-020 item 4); answers whether it is pending. */
      const classify = (
        events: readonly LaunchOutcomeEvent[],
        session?: DriverSession
      ): boolean => {
        const outcome = classifyLaunchOutcome(events, t0, clock.now())
        if (outcome.kind === 'pending') return true
        if (outcome.kind === 'failed') {
          if (session !== undefined) deps.releases?.release(session.ref)
          settle(failed(outcome.cause))
        } else if (session !== undefined) settle({ ok: true, value: session })
        return false
      }
      /** Runs `check` at `deadline`, again for the time left while it answers pending. */
      const at = (deadline: Instant, check: () => boolean): { cancel(): void } => {
        let current: { cancel(): void } | undefined
        const arm = (): void => {
          current = scheduler.after(Math.max(1, deadline - clock.now()), () => {
            if (!settled && check()) arm()
          })
        }
        arm()
        return { cancel: () => current?.cancel() }
      }

      const wrapped: DriverLaunchRequest = {
        ...req,
        onSpawned: async (identity) => {
          if (t0 === null) {
            t0 = clock.now()
            handshakeTimer = at(t0 + HANDSHAKE_TIMEOUT_MS, () => classify([]))
          }
          await req.onSpawned(identity)
        }
      }

      driver.launch(wrapped).then(
        (session) => {
          if (settled || t0 === null) {
            // Too late (the handshake budget ran out), or a driver that never reported its spawn
            // (15 §1.2: never skipped silently): the session is not the launch's.
            deps.releases?.release(session.ref)
            void session.close('end-thread')
            settle(failed('could-not-start'))
            return
          }
          handshakeTimer?.cancel()
          const readyAt = clock.now()
          const windowEnd = t0 + EARLY_FAILURE_WINDOW_MS
          const atWindowEnd = (): boolean => {
            const exited = deps.sessions.sessionFor(session.ref) === null
            const events: LaunchOutcomeEvent[] = [{ kind: 'ready', at: readyAt }]
            if (exited) events.push({ kind: 'ended', at: readyAt, how: 'exit' })
            return classify(events, session)
          }
          const pending = readyAt >= windowEnd ? atWindowEnd() : true
          if (pending) at(windowEnd, atWindowEnd)
        },
        (error: unknown) => {
          if (isDriverLaunchError(error)) settle(failed(error.cause, error.toolOutputTail))
          else settle(failed('could-not-start'))
        }
      )
    })
  }
}
