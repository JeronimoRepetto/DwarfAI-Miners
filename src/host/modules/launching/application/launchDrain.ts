// The launching module's half of the upgrade drain (ADR-002 D8 item 2; 07 S12.14; lead decision
// 2026-09-30 in ISSUE-032: EPIC-10 binds its blockers): every launch still in flight holds the drain
// as an `in-flight` blocker until it settles, read from `LaunchQueries.inFlight` at each ask. It only
// reads. The launch's settlement (`DwarfLaunched`, `LaunchFailed`) asks the drain again at once
// (wiring/hostDrainGate.ts `routeDrainRechecks`).
//
// Not yet here: a launched session's open turn (`open-turn`) and a live session whose driver cannot
// resume (`non-resumable-session`), item 3. Both need the driver's turn and capability events routed
// to launching, which wiring the launching module's write side brings (later: ISSUE-182).
import type { DrainBlocker, DrainGate } from '../../../kernel/ports/drainGate'
import type { LaunchQueries } from './launchQueries'

export function createLaunchDrainGate(deps: {
  launches: Pick<LaunchQueries, 'inFlight'>
}): DrainGate {
  return {
    blockers: (): readonly DrainBlocker[] =>
      deps.launches.inFlight().map((): DrainBlocker => ({ kind: 'in-flight' }))
  }
}
