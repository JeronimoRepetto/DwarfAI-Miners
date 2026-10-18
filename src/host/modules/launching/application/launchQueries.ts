// The launching read side (05 §3.5, 16 §4.5 `LaunchQueries`) and the Host memory the snapshot's
// `launches` section reads (14 §4.1 "`launches_in_flight` + Host memory"; 14 §4.3 rule 7).
//
// - `LaunchMemory` holds this boot's launches from acceptance until they leave the board: an
//   in-flight launch until it settles; a failed launch, with its `toolOutputTail` (memory only,
//   ADR-020 item 6, INV-55), until it is retried or the Host exits. A failure is listed only once
//   its `launch.failed` frame was written to a `ui` connection (`seen`, 14 §8 I-03): a launch that
//   failed while no UI was attached is never shown (PO #65; INV-53). A dismissal is UI-local
//   (14 §4.3 rule 7), so the Host keeps a seen failure until a retry or its exit.
// - `LaunchQueries` (16 §4.5): `inFlight` from that memory (only this boot's launches can be in
//   flight; one a stopped Host left is the recovery pass's, later: ISSUE-173), `ownedCount` = live
//   `LaunchRecord`s (the Stop-everything count), `launchedWithLetJevChoose` read through the
//   dwarf's launch record (09 D-17; the PO #50 delegation gate).
// - `LaunchSnapshotQueries` is this module's addition beside the frozen port (package gap, resolved
//   in development: `LaunchQueries.inFlight` cannot list the failures 14 §4.1 puts in the section):
//   `snapshot()` lists the in-flight launches and the seen failures, in acceptance order; `view(id)`
//   is one launch's current view, for its frames.
import type { LaunchFailure } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant, LaunchId, MineId, ProviderId } from '../../../kernel/domain/values'
import type { JevPicks } from '../domain/jevFallback'
import type { Launch, LaunchState } from '../domain/launch'
import type { LaunchRecordStore } from '../ports/launchRecordStore'

/** 06 §0.2 `Launch` read model: the fields of 14 §3.6 `LaunchWire`, no prompt (09 D-16). */
export interface LaunchView {
  launchId: LaunchId
  mineId: MineId
  state: LaunchState
  wayKind: 'supplier' | 'custom' | 'jev'
  providerId?: ProviderId
  model?: string
  effort?: string
  dwarfId?: DwarfId
  retryOf?: LaunchId
  picks?: JevPicks // state 'handed-back' (LaunchHandedBack, OQ-38 B)
  failure?: LaunchFailure // state 'failed'; its toolOutputTail is Host memory only
  requestedAt: Instant
}

/** 16 §4.5 `LaunchQueries` (driving). */
export interface LaunchQueries {
  inFlight(): LaunchView[]
  launchedWithLetJevChoose(dwarfId: DwarfId): boolean
  ownedCount(): number
}

/** The snapshot `launches` section's read (14 §4.1); beside the frozen port, see the header. */
export interface LaunchSnapshotQueries {
  snapshot(): LaunchView[]
  view(launchId: LaunchId): LaunchView | null
}

/** One launch's view, from its aggregate and its acceptance instant. */
export function viewOf(launch: Launch<unknown>, requestedAt: Instant): LaunchView {
  const { request } = launch
  const view: LaunchView = {
    launchId: launch.id,
    mineId: request.mineId,
    state: launch.state,
    wayKind: request.way.kind,
    requestedAt
  }
  // A Jev pick is the way the launch runs (S5.12; UC-009): its provider, model and capped effort.
  const { pick } = launch
  if (pick !== undefined) view.providerId = pick.providerId
  else if (request.way.kind === 'supplier') view.providerId = request.way.providerId
  const { model, effort } = pick ?? request
  if (model !== undefined) view.model = model
  if (effort !== undefined) view.effort = effort
  if (launch.dwarfId !== undefined) view.dwarfId = launch.dwarfId
  if (launch.retryOf !== undefined) view.retryOf = launch.retryOf
  if (launch.picks !== undefined) view.picks = launch.picks
  if (launch.failure !== undefined) view.failure = launch.failure
  return view
}

interface Held {
  view: LaunchView
  seen: boolean
}

const IN_FLIGHT: readonly LaunchState[] = ['routing', 'resolving', 'spawned']

export class LaunchMemory implements LaunchSnapshotQueries {
  private readonly held = new Map<LaunchId, Held>()

  /** A launch accepted, or moved forward: its current view. */
  put(view: LaunchView): void {
    const before = this.held.get(view.launchId)
    this.held.set(view.launchId, { view, seen: before?.seen ?? false })
  }

  /** The launch left the board: it succeeded, or a retry replaced its failure. */
  forget(launchId: LaunchId): void {
    this.held.delete(launchId)
  }

  /** Its `launch.failed` frame was written to a `ui` connection. */
  markSeen(launchId: LaunchId): void {
    const held = this.held.get(launchId)
    if (held !== undefined) held.seen = true
  }

  inFlight(): LaunchView[] {
    return [...this.held.values()]
      .filter(({ view }) => IN_FLIGHT.includes(view.state))
      .map(({ view }) => view)
  }

  snapshot(): LaunchView[] {
    return [...this.held.values()]
      .filter(
        ({ view, seen }) => IN_FLIGHT.includes(view.state) || (view.state === 'failed' && seen)
      )
      .map(({ view }) => view)
  }

  view(launchId: LaunchId): LaunchView | null {
    return this.held.get(launchId)?.view ?? null
  }
}

export function createLaunchQueries(deps: {
  memory: LaunchMemory
  records: Pick<LaunchRecordStore, 'all' | 'live'>
}): LaunchQueries {
  return {
    inFlight: () => deps.memory.inFlight(),
    ownedCount: () => deps.records.live().length,
    launchedWithLetJevChoose: (dwarfId) =>
      deps.records.all().find((record) => record.dwarfId === dwarfId)?.launchedWithLetJevChoose ??
      false
  }
}
