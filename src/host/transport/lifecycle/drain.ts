// The upgrade drain (ADR-002 D8 items 2–4; 07 S12.13–S12.16; 14 §3.4 `upgrade-drain` comment;
// AMENDMENT-2 SC-AR-03; lead decision 2026-09-30 in ISSUE-032): drain-and-resume, started by
// `host.upgrade.request` (same generation, a newer UI) or by `host.shutdown {upgrade-drain}` (the
// person confirmed a generation-bump restart). Both run this one drain:
//
// 1. `enter` — S12.13 `ready` → `upgrade-pending`: reported to the lifecycle state, which publishes
//    `host.state` to the `ui` connections; called by the handler, so that frame precedes its `res`
//    (14 §1.7). The Host keeps serving in compat mode meanwhile.
// 2. `start` — called once the answer was handed to the writer (`afterAnswer`), so the `res`
//    precedes any `host.closing`. From then on the DrainGate is asked at once, on each relevant
//    event (`recheck`, bound by the modules that own those events, EPIC-08 / EPIC-10) and on a
//    Scheduler tick every DRAIN_RECHECK_MS. While anything is open or in flight — a non-resumable
//    session above all — the Host stays `upgrade-pending` and keeps serving (S12.15, FM-024): the
//    drain waits, it never ends or interrupts a session (ADR-002 D8 items 3–4; no StopAllPort here).
// 3. Once nothing holds it — S12.14 `draining`: the session references are checkpointed and the
//    stdio children stopped (`checkpointSessions`, the launching module's hook, later: EPIC-10;
//    nothing to do at cut 0, where no session exists), with no PO #62 toast since the stop is
//    DwarfAI's own; then S12.16 the clean exit with reason `upgrade` (cleanExit.ts: the marker the
//    next boot reads to resume, `host.closing {reason:'upgrade'}`, the close, exit 0).
//
// Every call after the first is idempotent: a second request of either kind joins the drain. A
// Stop everything and quit meanwhile still runs; whichever clean exit comes first is the exit.
//
// `host.upgrade` is logged (19 §9.1, `info`, subsystem `host`) with the phase as its cause class:
// `upgrade-pending` on entry, `drain-blocked` with the blocker count the first time the gate holds,
// `draining` when it goes. Never what a person or provider said, and never a path.
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DrainGate } from '../../kernel/ports/drainGate'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { HostStateReport } from '../../wiring/boot'
import type { CleanExit } from './cleanExit'

/**
 * How often a held drain asks the DrainGate again when no event did. The package names no value;
 * the relevant events re-check at once, so the tick only bounds how long a missed event can delay
 * the swap, and a gate read is a few in-memory lookups.
 */
export const DRAIN_RECHECK_MS = 1_000

export interface UpgradeDrainDeps {
  gate: DrainGate
  /** The lifecycle state holder (hostState.ts): `upgrade-pending` is reported into it. */
  state: { report(report: HostStateReport): void; current(): HostStateReport }
  scheduler: Scheduler
  /** The Host's clean exit (cleanExit.ts). */
  lifecycle: CleanExit
  log: DiagnosticsLog
  /**
   * Checkpoints the session references (resume intents kept, ADR-015) and stops the stdio children
   * before the exit (S12.14, S12.16): the launching module's hook (later: EPIC-10). Absent at cut 0,
   * where no session exists.
   */
  checkpointSessions?: () => Promise<void>
}

export interface UpgradeDrain {
  /** S12.13: enters `upgrade-pending` (publishes `host.state`); before the request's answer. */
  enter(requestId: string): void
  /** Starts waiting on the DrainGate; once the request's answer was written. Idempotent. */
  start(): void
  /** Asks the DrainGate again now: a turn ended, an ask closed, a session ended (EPIC-08, EPIC-10). */
  recheck(): void
}

const SUBSYSTEM = 'host'
const EVENT = 'host.upgrade'

export function createUpgradeDrain(deps: UpgradeDrainDeps): UpgradeDrain {
  let phase: 'idle' | 'pending' | 'waiting' | 'draining' = 'idle'
  let tick: { cancel(): void } | null = null
  let reportedBlocked = false

  const check = (): void => {
    if (phase !== 'waiting') return
    tick?.cancel()
    tick = null
    const blockers = deps.gate.blockers()
    if (blockers.length > 0) {
      if (!reportedBlocked) {
        reportedBlocked = true
        deps.log.record({
          level: 'info',
          event: EVENT,
          subsystem: SUBSYSTEM,
          outcome: 'skipped',
          causeClass: 'drain-blocked',
          count: blockers.length
        })
      }
      tick = deps.scheduler.after(DRAIN_RECHECK_MS, check)
      return
    }
    phase = 'draining'
    deps.log.record({
      level: 'info',
      event: EVENT,
      subsystem: SUBSYSTEM,
      outcome: 'ok',
      causeClass: 'draining'
    })
    // A checkpoint that throws rejects before any host.closing: the Host then dies as a crash,
    // never as a clean exit that was not (cleanExit.ts).
    void (deps.checkpointSessions?.() ?? Promise.resolve()).then(() =>
      deps.lifecycle.closeCleanly('upgrade')
    )
  }

  return {
    enter(requestId) {
      if (phase !== 'idle') return
      phase = 'pending'
      deps.state.report({ ...deps.state.current(), state: 'upgrade-pending' })
      deps.log.record({
        level: 'info',
        event: EVENT,
        subsystem: SUBSYSTEM,
        outcome: 'ok',
        causeClass: 'upgrade-pending',
        requestId
      })
    },
    start() {
      if (phase !== 'pending') return
      phase = 'waiting'
      check()
    },
    recheck() {
      check()
    }
  }
}
