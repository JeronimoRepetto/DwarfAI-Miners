// The `Launch` aggregate and the Host launch machine (06 §8.1; ADR-020 D4; 07 machine 5B, the
// canonical transition table S5.10–S5.24). Pure: every instant is passed in (05 §2.2, R1).
import type { LaunchFailure, LaunchFailureCause } from '../../../kernel/domain/sharedContracts'
import type {
  DwarfId,
  HostEpoch,
  Instant,
  LaunchId,
  MineId,
  ProviderId,
  Result
} from '../../../kernel/domain/values'
import type { JevPick, JevPicks } from './jevFallback'

/** ADR-020 D1 `LaunchState` (transitions: 07 5B). */
export type LaunchState =
  | 'routing'
  | 'resolving'
  | 'spawned' // in flight
  | 'succeeded' // terminal: dwarf present
  | 'failed' // terminal: exactly one LaunchFailureCause
  | 'handed-back' // terminal, normal launch only: Jev's fallback filled the pickers (OQ-38 B)
  | 'lost' // terminal: the Host stopped before the launch settled, boot found no evidence (PO #65)

/** 06 §8.1: "Other…", parsed by `parseHostedCommand`, no shell. */
export interface CustomCommand {
  raw: string
  argv: readonly string[]
}

/** 06 §8.1 `LaunchWay` = supplier | custom | jev. */
export type LaunchWay =
  | { kind: 'supplier'; providerId: ProviderId }
  | { kind: 'custom'; command: CustomCommand }
  | { kind: 'jev' }

/**
 * 06 §8.1 `LaunchRequest` (VO, immutable once sent). The permission mode (suppliers'
 * `PermissionModeSpec`, ADR-011 item 1) and the delegation (ADR-013 item 5) belong to modules this
 * domain cannot import (R1), so they stay opaque type parameters filled in by the application.
 */
export interface LaunchRequest<PermissionMode = unknown, Delegation = unknown> {
  readonly mineId: MineId
  readonly way: LaunchWay
  readonly model?: string
  readonly effort?: string
  readonly permissionMode?: PermissionMode
  readonly prompt: string
  readonly jevOn: boolean
  readonly jevAutoAccept: boolean
  readonly delegation?: Delegation // set when the launch is a delegated worker (ADR-013 item 5)
}

/** 06 §8.1 `Launch` aggregate. */
export interface Launch<PermissionMode = unknown, Delegation = unknown> {
  readonly id: LaunchId // new per attempt, Retry included (ADR-020 item 8)
  readonly request: LaunchRequest<PermissionMode, Delegation>
  readonly state: LaunchState
  readonly failure?: LaunchFailure // set exactly when `state` is `failed`
  readonly spawnedAt?: Instant // t0 of the early-failure window
  readonly dwarfId?: DwarfId // set on `succeeded`
  readonly pick?: JevPick // S5.12: Jev's pick, the way the launch runs (UC-009)
  readonly picks?: JevPicks // S5.13: what `handed-back` put into the pickers (08 §0 LaunchHandedBack)
  readonly retryOf?: LaunchId // the attempt this Retry repeats
  readonly hostEpoch: HostEpoch
  readonly launchedWithLetJevChoose: boolean // ADR-013 items 4–5; false for a delegated worker
}

/** The 07 5B transition ids. */
export type LaunchTransitionId =
  | 'S5.10'
  | 'S5.11'
  | 'S5.12'
  | 'S5.13'
  | 'S5.14'
  | 'S5.15'
  | 'S5.16'
  | 'S5.17'
  | 'S5.18'
  | 'S5.19'
  | 'S5.20'
  | 'S5.21'
  | 'S5.22'
  | 'S5.23'
  | 'S5.24'

/** The 07 5B triggers after `LaunchRequested`. */
export type LaunchEvent =
  | { t: 'jev-picked'; pick?: JevPick } // S5.12: Jev picked (`pick`), or its fallback launched on the pickers' values
  | { t: 'handed-back'; picks?: JevPicks } // S5.13: Jev's fallback put the configured default into the pickers
  | { t: 'failed'; failure: LaunchFailure } // S5.14–S5.17, S5.19, S5.20
  | { t: 'spawned'; at: Instant } // S5.18: process started at t0
  | { t: 'succeeded'; dwarfId: DwarfId } // S5.21: handshake ready and early window survived
  | { t: 'boot-reconciled'; evidence: DwarfId | null } // S5.22 (no evidence), S5.23 (evidence)
  | { t: 'ui-visibility'; what: 'add-panel-closed' | 'window-closed' | 'ui-detached' } // S5.24

export interface LaunchStep<PermissionMode = unknown, Delegation = unknown> {
  launch: Launch<PermissionMode, Delegation>
  via: LaunchTransitionId
}

export interface NewLaunch<PermissionMode = unknown, Delegation = unknown> {
  id: LaunchId
  request: LaunchRequest<PermissionMode, Delegation>
  hostEpoch: HostEpoch
  retryOf?: LaunchId
}

/** S5.10 / S5.11: `LaunchRequested`. Refused when the request is not sendable (INV-50). */
export function requestLaunch<P, D>(
  input: NewLaunch<P, D>
): Result<LaunchStep<P, D>, 'not-sendable'> {
  const { request } = input
  if (!isSendable(request)) return { ok: false, error: 'not-sendable' }
  const delegated = request.delegation !== undefined
  const routed = request.jevOn || delegated
  const launch: Launch<P, D> = {
    id: input.id,
    request,
    state: routed ? 'routing' : 'resolving',
    hostEpoch: input.hostEpoch,
    launchedWithLetJevChoose: request.jevOn && !delegated,
    ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {})
  }
  return { ok: true, value: { launch, via: routed ? 'S5.10' : 'S5.11' } }
}

/** INV-50: a way to run (a custom command must not be blank) and a non-blank prompt. */
function isSendable(request: LaunchRequest<unknown, unknown>): boolean {
  if (request.prompt.trim() === '') return false
  return request.way.kind !== 'custom' || request.way.command.raw.trim() !== ''
}

type InFlight = Extract<LaunchState, 'routing' | 'resolving' | 'spawned'>

/** 07 5B: which cause each in-flight state may fail with, and through which transition. */
const FAILURES: Record<InFlight, Partial<Record<LaunchFailureCause, LaunchTransitionId>>> = {
  routing: { 'jev-unreachable': 'S5.14', 'jev-could-not-choose': 'S5.15' },
  resolving: { 'not-installed': 'S5.16', 'could-not-start': 'S5.17' },
  spawned: { 'could-not-start': 'S5.19', 'exited-at-once': 'S5.20' }
}

function isInFlight(state: LaunchState): state is InFlight {
  return state === 'routing' || state === 'resolving' || state === 'spawned'
}

/** One 5B transition; a transition 07 does not list is refused and the launch is unchanged. */
export function applyLaunchEvent<P, D>(
  launch: Launch<P, D>,
  event: LaunchEvent
): Result<LaunchStep<P, D>, 'transition-refused'> {
  const { state } = launch
  if (!isInFlight(state)) return refused() // terminal states have no way out
  const step = (via: LaunchTransitionId, next: Launch<P, D>): Result<LaunchStep<P, D>, never> => ({
    ok: true,
    value: { launch: next, via }
  })
  switch (event.t) {
    case 'ui-visibility':
      return step('S5.24', launch) // UI visibility only; the Host launch is unaffected
    case 'boot-reconciled':
      if (event.evidence === null) return step('S5.22', { ...launch, state: 'lost' })
      if (state !== 'spawned') return refused()
      return step('S5.23', { ...launch, state: 'succeeded', dwarfId: event.evidence })
    case 'failed': {
      const via = FAILURES[state][event.failure.cause]
      if (via === undefined) return refused()
      return step(via, { ...launch, state: 'failed', failure: event.failure })
    }
    case 'jev-picked':
      if (state !== 'routing') return refused()
      return step('S5.12', {
        ...launch,
        state: 'resolving',
        ...(event.pick === undefined ? {} : { pick: event.pick })
      })
    case 'handed-back':
      if (state !== 'routing' || launch.request.delegation !== undefined) return refused()
      return step('S5.13', {
        ...launch,
        state: 'handed-back',
        ...(event.picks === undefined ? {} : { picks: event.picks })
      })
    case 'spawned':
      if (state !== 'resolving') return refused()
      return step('S5.18', { ...launch, state: 'spawned', spawnedAt: event.at })
    case 'succeeded':
      if (state !== 'spawned') return refused()
      return step('S5.21', { ...launch, state: 'succeeded', dwarfId: event.dwarfId })
  }
}

function refused(): { ok: false; error: 'transition-refused' } {
  return { ok: false, error: 'transition-refused' }
}
