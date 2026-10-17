// The Jev fallback → launch cause mapping (ADR-020 item 2; 16 §6.4; ADR-028 D2) and the routing
// decision a normal Jev launch settles with in `routing` (07 S5.12–S5.15). Pure (05 §2.2, R1).
//
// - `unreachable | timeout | rate-limited | invalid-response` → `jev-unreachable` (Retry, Pick
//   manually, S5.14); every other reason → `jev-could-not-choose` (Pick manually only, none with
//   `no-launchable-provider`, S5.15). `effort-ceiling` is a reason, never a sixth cause (INV-52):
//   with nothing handed back, or on a delegated subtask, it cannot choose. Actions and the cause-5
//   sentence (the fixed "No launchable provider to choose from.", else the ⟦COPY NEEDED: S-020-2⟧
//   placeholder) are `buildLaunchFailure`'s (launchFailure.ts).
// - `no-key` is what the `LaunchAdvisor` bridge reports for `JevAdvisor`'s `not-configured`
//   (16 §13 O-16-06): `jev-could-not-choose` with `jevReason: 'no-key'`.
// - Either Jev cause is set only when the fallback launched nothing (ADR-020 item 2): a fallback
//   with the pickers' values launches on them (S5.12), and a fallback carrying the configured
//   default hands it back to the pickers (S5.13, OQ-38 B).
import type {
  JevFallbackReason,
  LaunchFailure,
  LaunchFailureCause
} from '../../../kernel/domain/sharedContracts'
import type { ProviderId, Result } from '../../../kernel/domain/values'
import { buildLaunchFailure } from './launchFailure'

/** The two Jev causes of ADR-020 D1 (causes 4 and 5). */
export type JevLaunchCause = Extract<LaunchFailureCause, 'jev-unreachable' | 'jev-could-not-choose'>

/**
 * What the launch reads of Jev's answer: the 06 §12 `JevSuggestion` parts it launches with, and its
 * fallback. Structural, so this domain never imports the jev module (R1).
 */
export interface JevAnswer {
  providerId?: ProviderId
  model?: string
  effort?: string
  fallback?: JevFallbackReason
}

/** 08 §0 `LaunchHandedBack.picks`: what the pickers get back. */
export interface JevPicks {
  providerId?: ProviderId
  model?: string
  effort?: string
}

/** Jev's pick: the provider it chose, with the model and the capped effort (ADR-028 D1). */
export type JevPick = JevPicks & { providerId: ProviderId }

export type JevRouting =
  | { kind: 'picked'; pick: JevPick } // S5.12: Jev picked
  | { kind: 'pickers' } // S5.12: the fallback launches on the pickers' values
  | { kind: 'handed-back'; picks: JevPicks } // S5.13: the configured default into the pickers
  | { kind: 'failed'; failure: LaunchFailure } // S5.14, S5.15: nothing went out

/** ADR-020 D2: the fallbacks a retry can change (S5.14); the others could not choose (S5.15). */
const RETRYABLE: ReadonlySet<JevFallbackReason> = new Set([
  'unreachable',
  'timeout',
  'rate-limited',
  'invalid-response'
])

export function jevLaunchCause(reason: JevFallbackReason): JevLaunchCause {
  return RETRYABLE.has(reason) ? 'jev-unreachable' : 'jev-could-not-choose'
}

/** The `LaunchFailure` of a fallback that launched nothing, with its reason (ADR-020 D1–D2). */
export function jevFallbackFailure(
  reason: JevFallbackReason,
  supplierLabel: string
): LaunchFailure {
  return buildLaunchFailure({ cause: jevLaunchCause(reason), supplierLabel, jevReason: reason })
}

/** The parts of an answer that are set, as the pickers or the driver take them. */
function picksOf(answer: JevAnswer): JevPicks {
  return {
    ...(answer.providerId === undefined ? {} : { providerId: answer.providerId }),
    ...(answer.model === undefined ? {} : { model: answer.model }),
    ...(answer.effort === undefined ? {} : { effort: answer.effort })
  }
}

/**
 * A normal Jev launch's way out of `routing`. `pickers` is true when the request carries a supplier
 * the person's pickers hold. An advisor error names its cause only, so the failure has no
 * `jevReason`; an answer with neither a pick nor a fallback is Jev's invalid response.
 */
export function decideJevRouting(
  answer: Result<JevAnswer, JevLaunchCause>,
  ctx: { supplierLabel: string; pickers: boolean }
): JevRouting {
  if (!answer.ok) {
    return {
      kind: 'failed',
      failure: buildLaunchFailure({ cause: answer.error, supplierLabel: ctx.supplierLabel })
    }
  }
  const { value } = answer
  if (value.fallback === undefined) {
    if (value.providerId === undefined) {
      return { kind: 'failed', failure: jevFallbackFailure('invalid-response', ctx.supplierLabel) }
    }
    return { kind: 'picked', pick: { ...picksOf(value), providerId: value.providerId } }
  }
  if (ctx.pickers) return { kind: 'pickers' }
  if (value.providerId !== undefined) return { kind: 'handed-back', picks: picksOf(value) }
  return { kind: 'failed', failure: jevFallbackFailure(value.fallback, ctx.supplierLabel) }
}

/**
 * How long a launch waits in `routing` for Jev before it aborts the call (16 §6.5 `AbortSignal`):
 * 16 §6.5's 8 000 ms per attempt for each of the two requests of 16 §6.1 (`route`, `routeModel`).
 * The router times each attempt out itself; this bound only keeps a launch whose answer never
 * comes from staying in flight, and it settles the `timeout` fallback (S5.14).
 */
export const JEV_ROUTING_BUDGET_MS = 2 * 8_000
