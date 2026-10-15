// The delegation limits (ADR-013 item 1; 16 §5.4, §5.5): refusals that create no delegation.
//
// - Depth 1 (INV-81): a call from a delegated worker's session is `depth-exceeded`. Such a session
//   is never given the delegation server (`DelegationLifecycle.issueFor`); this is the second wall.
// - The in-flight caps: a call while the parent already has `MAX_DELEGATIONS_PER_PARENT`, or the
//   Host `MAX_DELEGATIONS_GLOBAL`, delegations `attempted` or `running` is `concurrency-limit`.
//   The values are the transplanted caps (`src/main/mcp/delegationConcurrency.ts`
//   `DEFAULT_MAX_DELEGATIONS_PER_PARENT = 2`, `DEFAULT_MAX_DELEGATIONS_GLOBAL = 4`): each slot is
//   a real provider process, so the caps are a conservative safety rail, not a capacity plan.
//
// Counting is the caller's: it passes the in-flight counts read from the delegations it holds.
// Pure: no I/O, no clock (05 §2.2, R1).
import type { Result } from '../../../kernel/domain/values'

/** Delegations in flight for one parent at once (transplanted cap). */
export const MAX_DELEGATIONS_PER_PARENT = 2
/** Delegations in flight in the Host at once (transplanted cap). */
export const MAX_DELEGATIONS_GLOBAL = 4

/** A refusal before any delegation exists (16 §5.4: no delegation row is created). */
export type DelegationLimitRefusal = 'concurrency-limit' | 'depth-exceeded'

/** In-flight (`attempted` or `running`) delegations: the parent's own and all of them. */
export interface InFlightCounts {
  readonly parent: number
  readonly global: number
}

/** Depth 1: a delegated worker never delegates (INV-81). */
export function checkDepth(caller: {
  readonly delegated: boolean
}): Result<'within', 'depth-exceeded'> {
  return caller.delegated ? { ok: false, error: 'depth-exceeded' } : { ok: true, value: 'within' }
}

/** The per-parent and global in-flight caps. */
export function checkConcurrency(inFlight: InFlightCounts): Result<'within', 'concurrency-limit'> {
  if (inFlight.parent >= MAX_DELEGATIONS_PER_PARENT || inFlight.global >= MAX_DELEGATIONS_GLOBAL) {
    return { ok: false, error: 'concurrency-limit' }
  }
  return { ok: true, value: 'within' }
}

/** Depth first, then the caps. */
export function checkLimits(
  caller: { readonly delegated: boolean },
  inFlight: InFlightCounts
): Result<'within', DelegationLimitRefusal> {
  const depth = checkDepth(caller)
  return depth.ok ? checkConcurrency(inFlight) : depth
}
