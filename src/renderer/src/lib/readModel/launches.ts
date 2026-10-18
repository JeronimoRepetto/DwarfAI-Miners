import {
  HOST_FRAME_SCHEMAS,
  type HostFrame,
  type LaunchFailure,
  type LaunchId,
  type LaunchState,
  type LaunchWire,
  type MineId,
  type SnapshotChunk
} from '@dwarfai/contracts'

/*
 * The launches as the Host states them (ISSUE-179 read side; ADR-020 D1; 14 §4.1 `launches`, §4.3 rule 7): the
 * snapshot `launches` section (in-flight launches, and failed ones not yet retried or dismissed), then the
 * `launch.changed` and `launch.failed` frames. Pure folds for the `useAgentLaunch` read model (ADR-033 item 3): nothing
 * here reads a clock, and a launch leaves "in flight" only on the Host's word (NFR-TIM-07).
 */

/** One launch the Host told the window about. */
export interface HostLaunch {
  launchId: LaunchId
  mineId: MineId
  /** The Host's last `LaunchWire` of it; null when only its `launch.failed` frame is known. */
  wire: LaunchWire | null
  /** Its failure (cause, supplier label, actions, tool output tail), as `launch.failed` or the snapshot carried it. */
  failure: LaunchFailure | null
}

export type HostLaunches = Map<LaunchId, HostLaunch>

/** Re-exported for the composable, which reads its frame type from here. */
export type { HostFrame }

/** ADR-020 D1: the states of a launch still on its way (07 5B). */
const IN_FLIGHT: ReadonlySet<LaunchState> = new Set(['routing', 'resolving', 'spawned'])

function fromWire(wire: LaunchWire): HostLaunch {
  return { launchId: wire.launchId, mineId: wire.mineId, wire, failure: wire.failure ?? null }
}

/** The launches of one snapshot, every page joined. */
export function hostLaunchesOf(chunks: readonly SnapshotChunk[]): HostLaunches {
  const launches: HostLaunches = new Map()
  for (const chunk of chunks) {
    if (chunk.section !== 'launches') continue
    for (const wire of chunk.data) launches.set(wire.launchId, fromWire(wire))
  }
  return launches
}

/** Applies one frame newer than the snapshot; a frame whose data is not its 14 §3.5 payload is ignored. */
export function applyLaunchFrame(launches: HostLaunches, frame: HostFrame): void {
  if (frame.name === 'launch.changed') {
    const parsed = HOST_FRAME_SCHEMAS['launch.changed'].safeParse(frame.data)
    if (parsed.success) launches.set(parsed.data.launch.launchId, fromWire(parsed.data.launch))
    return
  }
  if (frame.name === 'launch.failed') {
    const parsed = HOST_FRAME_SCHEMAS['launch.failed'].safeParse(frame.data)
    if (!parsed.success) return
    const { launchId, mineId, failure } = parsed.data
    launches.set(launchId, {
      launchId,
      mineId,
      wire: launches.get(launchId)?.wire ?? null,
      failure
    })
  }
}

/** Whether the Host last said this launch is on its way: a known in-flight state and no failure. */
export function launchInFlight(launch: HostLaunch): boolean {
  return launch.failure === null && launch.wire !== null && IN_FLIGHT.has(launch.wire.state)
}
