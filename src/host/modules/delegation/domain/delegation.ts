// The `Delegation` aggregate and machine 8 (06 §11.1; 07 §8; ADR-013 items 1, 4–6): pure
// transitions over plain values. Time is passed in and only stamps `createdAt`, `settledAt` and
// `handoff.phaseAt` (05 §2.2, R1).
//
// - `admitDelegation` is a `delegate_subtask` call reaching the domain, checked in this order:
//   a delegated caller is `depth-exceeded` (INV-81), with no delegation; the gate is re-read
//   (INV-80): closed → a delegation created `failed` with `gate-closed` (S8.02, no Jev call); the
//   per-parent and global caps → `concurrency-limit`, with no delegation (16 §5.4); otherwise
//   `attempted` (S8.01). Depth comes first so a worker never gets a `gate-closed` row and a parent
//   line; the gate comes before the caps as `DelegationEndpoint.delegate` re-checks it first.
// - `applyEvent` moves an existing delegation along 07 §8 and refuses every pair 07 does not list,
//   changing nothing. The Settings toggle and a closed window are **no transition** (S8.10): a
//   delegation in flight, `attempted` or `running`, keeps going (PO #51, INV-80).
// - `beginHandoff` writes `handoff.phase = 'sending'` on a `running` delegation before the result
//   is handed over (16 §5.4 "Handoff"); it is a field write, not a machine-8 transition. Success
//   needs that handoff to reach `delivered` (S8.08, INV-68); a failed turn-input push is not
//   retried (S8.13, ADR-013 O-13b).
//
// The aggregate never violates the `delegations` CHECKs (09 §4.6): `failure` set exactly when
// `failed`; `settledAt` set exactly when settled; `succeeded` only with `handoff.phase =
// 'delivered'`; the task and context dropped once settled; a worker never the parent itself.
import type { DwarfId, Instant, Result } from '../../../kernel/domain/values'
import { allows, type DelegationGateLaunch, type DelegationGatePreferences } from './delegationGate'
import {
  checkConcurrency,
  checkDepth,
  type DelegationLimitRefusal,
  type InFlightCounts
} from './limits'
import type { Subtask, SubtaskText } from './subtaskText'

/** The DwarfAI id of a delegation (06 §11.1; 09 `delegations.id`). */
export type DelegationId = string & { readonly __brand: 'DelegationId' }

/** 06 `DelegationState`. */
export type DelegationState = 'attempted' | 'running' | 'succeeded' | 'failed'

/** 06 `DelegationFailure`. */
export type DelegationFailure =
  | 'gate-closed'
  | 'jev-unreachable'
  | 'jev-could-not-choose'
  | 'no-provider'
  | 'worker-failed'
  | 'worker-lost'
  | 'handoff-failed'
  | 'parent-gone'

/** 06 `DelegationHandoff`: the delivery state of the invisible result (INV-68). */
export interface DelegationHandoff {
  readonly via: 'tool-result' | 'turn-input'
  readonly phase: 'sending' | 'delivered' | 'failed'
  readonly phaseAt: Instant
}

/**
 * 06 §11.1 `Delegation`. The task and context are kept only while the delegation is in flight
 * (09 §4.6 CHECK; 16 §5.6); the result text is never a field (INV-68).
 */
export interface Delegation {
  readonly id: DelegationId
  readonly parentDwarfId: DwarfId
  readonly workerDwarfId?: DwarfId
  readonly ticket: string
  readonly task?: SubtaskText
  readonly context?: SubtaskText
  readonly state: DelegationState
  readonly failure?: DelegationFailure
  readonly handoff?: DelegationHandoff
  readonly createdAt: Instant
  readonly settledAt?: Instant
}

/** The stable transition ids of machine 8 (07 §8). */
export type DelegationTransitionId =
  | 'S8.01'
  | 'S8.02'
  | 'S8.03'
  | 'S8.04'
  | 'S8.05'
  | 'S8.06'
  | 'S8.07'
  | 'S8.08'
  | 'S8.09'
  | 'S8.10'
  | 'S8.11'
  | 'S8.12'
  | 'S8.13'

/** What happens to an existing delegation: one trigger per 07 §8 row. */
export type DelegationEvent =
  /** S8.03: the worker's delegated launch reached `succeeded` (machine 5). */
  | { readonly type: 'worker-launched'; readonly workerDwarfId: DwarfId }
  /** S8.04: Jev's fallback is retryable. */
  | { readonly type: 'jev-unreachable' }
  /** S8.05: Jev's fallback is not retryable, `effort-ceiling` included (OQ-38 A; ADR-028 D2). */
  | { readonly type: 'jev-could-not-choose' }
  /** S8.06: no launchable provider. */
  | { readonly type: 'no-provider' }
  /** S8.07: the worker's launch ended `failed` with any `LaunchFailureCause`. */
  | { readonly type: 'worker-launch-failed' }
  /** S8.08: the handoff reached `delivered`. */
  | { readonly type: 'handoff-delivered' }
  /** S8.09: the worker's session ended without a result, or `boot:` reconcile found it gone. */
  | { readonly type: 'worker-lost' }
  /** S8.10: the Settings toggle turned off. */
  | { readonly type: 'setting-turned-off' }
  /** S8.10: the window closed. */
  | { readonly type: 'window-closed' }
  /** S8.11: the parent's session ended. */
  | { readonly type: 'parent-session-ended' }
  /** S8.12: `boot:` found a Host crash while routing. */
  | { readonly type: 'host-crashed-while-routing' }
  /** S8.13 (or S8.11 when the parent's session is gone): a turn-input push failed. */
  | { readonly type: 'handoff-push-failed'; readonly parentSessionAlive: boolean }

/** Why an event was refused; the delegation is unchanged. */
export type DelegationEventRefusal = 'not-in-machine-8' | 'worker-is-parent' | 'handoff-not-sending'

/** A `delegate_subtask` call as the domain sees it (16 §5.4; `DelegationEndpoint.delegate`). */
export interface DelegationAdmission {
  readonly id: DelegationId
  readonly ticket: string
  readonly parentDwarfId: DwarfId
  readonly subtask: Subtask
  readonly preferences: DelegationGatePreferences
  /** The calling session's launch record. */
  readonly launch: DelegationGateLaunch
  readonly inFlight: InFlightCounts
}

/** S8.01 or S8.02 (see the file header). The limits refuse before any delegation exists. */
export function admitDelegation(
  input: DelegationAdmission,
  at: Instant
): Result<{ delegation: Delegation; transition: 'S8.01' | 'S8.02' }, DelegationLimitRefusal> {
  const depth = checkDepth(input.launch)
  if (!depth.ok) return depth
  const base = { id: input.id, parentDwarfId: input.parentDwarfId, ticket: input.ticket }
  if (!allows(input.preferences, input.launch)) {
    return {
      ok: true,
      value: {
        delegation: {
          ...base,
          state: 'failed',
          failure: 'gate-closed',
          createdAt: at,
          settledAt: at
        },
        transition: 'S8.02'
      }
    }
  }
  const concurrency = checkConcurrency(input.inFlight)
  if (!concurrency.ok) return concurrency
  const delegation: Delegation = {
    ...base,
    task: input.subtask.task,
    ...(input.subtask.context === undefined ? {} : { context: input.subtask.context }),
    state: 'attempted',
    createdAt: at
  }
  return { ok: true, value: { delegation, transition: 'S8.01' } }
}

type Applied = Result<
  { delegation: Delegation; transition: DelegationTransitionId },
  DelegationEventRefusal
>

/** Moves `delegation` along 07 §8, or refuses a pair 07 does not list. */
export function applyEvent(delegation: Delegation, event: DelegationEvent, at: Instant): Applied {
  const { state } = delegation
  if (state === 'succeeded' || state === 'failed') return refused('not-in-machine-8')

  switch (event.type) {
    case 'setting-turned-off':
    case 'window-closed':
      // S8.10: no transition (PO #51); an `attempted` delegation is in flight too (INV-80).
      return { ok: true, value: { delegation, transition: 'S8.10' } }
    case 'parent-session-ended':
      return settleFailed(delegation, 'parent-gone', 'S8.11', at)
    case 'worker-launched':
      if (state !== 'attempted') return refused('not-in-machine-8')
      if (event.workerDwarfId === delegation.parentDwarfId) return refused('worker-is-parent')
      return {
        ok: true,
        value: {
          delegation: { ...delegation, state: 'running', workerDwarfId: event.workerDwarfId },
          transition: 'S8.03'
        }
      }
    case 'jev-unreachable':
      return state === 'attempted'
        ? settleFailed(delegation, 'jev-unreachable', 'S8.04', at)
        : refused('not-in-machine-8')
    case 'jev-could-not-choose':
      return state === 'attempted'
        ? settleFailed(delegation, 'jev-could-not-choose', 'S8.05', at)
        : refused('not-in-machine-8')
    case 'no-provider':
      return state === 'attempted'
        ? settleFailed(delegation, 'no-provider', 'S8.06', at)
        : refused('not-in-machine-8')
    case 'worker-launch-failed':
      return state === 'attempted'
        ? settleFailed(delegation, 'worker-failed', 'S8.07', at)
        : refused('not-in-machine-8')
    case 'host-crashed-while-routing':
      // Proposed in 07: no worker exists yet, so the failure is `worker-lost`.
      return state === 'attempted'
        ? settleFailed(delegation, 'worker-lost', 'S8.12', at)
        : refused('not-in-machine-8')
    case 'worker-lost':
      return state === 'running'
        ? settleFailed(delegation, 'worker-lost', 'S8.09', at)
        : refused('not-in-machine-8')
    case 'handoff-delivered': {
      if (state !== 'running') return refused('not-in-machine-8')
      const { handoff } = delegation
      if (handoff?.phase !== 'sending') return refused('handoff-not-sending')
      return {
        ok: true,
        value: {
          delegation: settle(delegation, at, {
            state: 'succeeded',
            handoff: { via: handoff.via, phase: 'delivered', phaseAt: at }
          }),
          transition: 'S8.08'
        }
      }
    }
    case 'handoff-push-failed': {
      if (state !== 'running') return refused('not-in-machine-8')
      const { handoff } = delegation
      if (handoff?.via !== 'turn-input' || handoff.phase !== 'sending') {
        return refused('handoff-not-sending')
      }
      // No retry: a second copy could reach the parent twice (ADR-013 O-13b). With the parent's
      // session gone S8.11 applies instead (`parent-gone`, no line).
      return event.parentSessionAlive
        ? settleFailed(delegation, 'handoff-failed', 'S8.13', at)
        : settleFailed(delegation, 'parent-gone', 'S8.11', at)
    }
  }
}

/**
 * Writes `handoff.phase = 'sending'` on a `running` delegation, once, before the result is handed
 * over (16 §5.4 "Handoff"). Not a machine-8 transition: the state stays `running`.
 */
export function beginHandoff(
  delegation: Delegation,
  via: DelegationHandoff['via'],
  at: Instant
): Result<Delegation, 'not-running' | 'handoff-already-begun'> {
  if (delegation.state !== 'running') return { ok: false, error: 'not-running' }
  if (delegation.handoff !== undefined) return { ok: false, error: 'handoff-already-begun' }
  return { ok: true, value: { ...delegation, handoff: { via, phase: 'sending', phaseAt: at } } }
}

function refused(error: DelegationEventRefusal): Applied {
  return { ok: false, error }
}

/** Settles `failed`; a handoff still `sending` failed with it (S8.11, S8.13). */
function settleFailed(
  delegation: Delegation,
  failure: DelegationFailure,
  transition: DelegationTransitionId,
  at: Instant
): Applied {
  const { handoff } = delegation
  const failedHandoff =
    handoff?.phase === 'sending'
      ? { handoff: { ...handoff, phase: 'failed' as const, phaseAt: at } }
      : {}
  return {
    ok: true,
    value: {
      delegation: settle(delegation, at, { state: 'failed', failure, ...failedHandoff }),
      transition
    }
  }
}

/** A settled delegation: `settledAt` stamped, the task and context dropped (09 §4.6). */
function settle(
  delegation: Delegation,
  at: Instant,
  change: Pick<Delegation, 'state'> & Partial<Pick<Delegation, 'failure' | 'handoff'>>
): Delegation {
  const { task: _task, context: _context, ...kept } = delegation
  return { ...kept, ...change, settledAt: at }
}
