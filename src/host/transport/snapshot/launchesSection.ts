// The snapshot's `launches` section (14 §3.7, §4.1, §4.3 rule 7, frozen; ADR-020 items 5–6): the
// in-flight launches, and the failed launches not yet retried, each as 14 §3.6 `LaunchWire`, read
// from the launching module's Host memory (`LaunchSnapshotQueries`, modules/launching). `ui` only.
// Live updates: `launch.changed` and `launch.failed` (wiring/routes/launching.ts). Registered
// before the bind by the launching wiring, it is advertised as `section:launches` (14 §4.4).
//
// - A failure is listed only once its `launch.failed` frame was written to a `ui` connection
//   (`launches.seen_at`, 14 §8 I-03): a launch that failed while no UI was attached appears in no
//   snapshot (PO #65; INV-53; FM-135). A dismissal is UI-local (14 §4.3 rule 7).
// - A listed failure carries its `toolOutputTail` (≤ 400 chars, causes 2–3 only), which lives in
//   Host memory only and is lost when the Host exits (OQ-50; INV-55).
// - Synchronous like every provider (sectionRegistry.ts), so the section reflects exactly the frames
//   up to the snapshot's `seq` (14 §4.2).
//
// Nothing here logs: the tail is tool output (14 §3.5 SENSITIVE_METHODS `session.snapshot`).
import type { LaunchWire } from '@dwarfai/contracts'
import type { LaunchSnapshotQueries, LaunchView } from '../../modules/launching'
import type { SectionProvider, SectionRegistry } from './sectionRegistry'

/** 14 §3.6 `LaunchWire` of one launch view: each wire field named and copied. */
export function toLaunchWire(view: LaunchView): LaunchWire {
  const wire: LaunchWire = {
    launchId: view.launchId,
    mineId: view.mineId,
    state: view.state,
    wayKind: view.wayKind,
    requestedAt: view.requestedAt
  }
  if (view.providerId !== undefined) wire.providerId = view.providerId
  if (view.model !== undefined) wire.model = view.model
  if (view.effort !== undefined) wire.effort = view.effort
  if (view.dwarfId !== undefined) wire.dwarfId = view.dwarfId
  if (view.retryOf !== undefined) wire.retryOf = view.retryOf
  if (view.failure !== undefined) wire.failure = { ...view.failure }
  return wire
}

export interface LaunchesSectionDeps {
  launches: Pick<LaunchSnapshotQueries, 'snapshot'>
}

/** The `launches` provider over `deps`. */
export function launchesSection(deps: LaunchesSectionDeps): SectionProvider<'launches'> {
  return () => deps.launches.snapshot().map(toLaunchWire)
}

/** Registers the `launches` section (`ui` only), so it is advertised as `section:launches`. */
export function registerLaunchesSection(
  sections: SectionRegistry,
  deps: LaunchesSectionDeps
): void {
  sections.registerSection('launches', ['ui'], launchesSection(deps))
}
