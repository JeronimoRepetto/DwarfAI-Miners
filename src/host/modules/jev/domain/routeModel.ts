// The second request's decision (#608; 16 §6.1-§6.3): which of the tier's candidate models Jev's
// answer picks, under the same effort ceiling as the first request (ADR-028 item 2). Transplanted
// from the model step of the found tree's `src/main/jev/routeLaunch.ts` (`resolveModelPart`), as
// pure functions around the router call: the call itself, its budget and its abort signal are the
// application's (ISSUE-192). Pure: no I/O, no clock read (05 §2.2, R1).
import type { JevFallbackReason } from '../../../kernel/domain/sharedContracts'
import type { ModelCapabilityEntry, ModelTier } from './capabilities/modelCapability'
import {
  eligibleCandidates,
  finalizeModel,
  minOfAnswered,
  selectModelWinner,
  type EffortLadders,
  type JevDecideResult,
  type JevRouteFallback,
  type ModelSelectionCandidate
} from './routeDecision'
import type { JevRoutingProfile } from './suggestion'

/**
 * Jev's own answer to the second request — RAW, never yet resolved onto a winner
 * (`selectModelWinner` does that): every candidate's Noul "does it fit" probability and the
 * tie-breaking Choice's full distribution, all keyed by the index the candidate was sent under.
 */
export interface JevModelAnswers {
  kind: 'answers'
  fits: Readonly<Record<string, number>>
  choice: { choice: string; probabilities: Readonly<Record<string, number>> }
  usage: { inputTokens: number }
}

/** Why the second request was not used, or not acted on: a fallback reason, or nothing live. */
export type JevModelFallbackReason = JevFallbackReason | 'no-live-model'

/**
 * The model step behind one decision (#608): Jev answers it with a Noul per candidate plus a
 * tie-breaking Choice, so it says how the model was reached rather than reusing a Choice part.
 */
export interface JevModelPart {
  /** The chosen model's own id; absent only for `'no-live-model'`. */
  value?: string
  /**
   * `'answered'`: the second request picked it. `'only-candidate'`: exactly one candidate, no second
   * request. `'safe-default'`: the second request could not be sent, failed, or could not be acted
   * on, and the local cost/profile pick was used.
   */
  applied: 'answered' | 'safe-default' | 'only-candidate'
  /** The winner's own Noul probability, only when `applied === 'answered'`. */
  probability?: number
  /** The Choice's probability for the winner, only when the tie band made the Choice decide. */
  choiceProbability?: number
  /** Why the second request was not used, only when `applied === 'safe-default'`. */
  reason?: JevModelFallbackReason
}

/** A first-request decision: the input of the model step. */
export type LaunchDecision = Extract<JevDecideResult, { kind: 'decision' }>

/** The model the step settled on, with its part; `model`/`effort` absent when nothing is live. */
export interface SettledModel {
  kind: 'model'
  model?: string
  effort?: string
  part: JevModelPart
}

/** What the model step needs before any second request (`planModelStep`). */
export type ModelStepPlan =
  | SettledModel
  | {
      kind: 'ask'
      /** The tier the candidates occupy: the second request's own `tier`. */
      tier: ModelTier
      /** Two or more candidates, in the order their indices are sent under. */
      candidates: readonly { id: string; entry: ModelCapabilityEntry }[]
    }

/**
 * The local cost/profile pick of the first request, used whenever the second request is skipped,
 * fails or cannot be acted on, with the reason it was not used.
 */
export function safeDefaultModel(
  decided: LaunchDecision,
  reason: JevModelFallbackReason
): SettledModel {
  return {
    kind: 'model',
    ...(decided.model === undefined ? {} : { model: decided.model }),
    ...(decided.effort === undefined ? {} : { effort: decided.effort }),
    part: {
      ...(decided.model === undefined ? {} : { value: decided.model }),
      applied: 'safe-default',
      reason
    }
  }
}

/**
 * Whether a second request is needed (#608): no live candidate settles as `'no-live-model'`,
 * exactly one as `'only-candidate'` (no second request), two or more ask.
 */
export function planModelStep(decided: LaunchDecision): ModelStepPlan {
  const candidates = decided.modelCandidates.options
  const only = candidates.length === 1 ? candidates[0] : undefined
  if (candidates.length === 0) return safeDefaultModel(decided, 'no-live-model')
  if (only !== undefined) {
    return {
      kind: 'model',
      ...(decided.model === undefined ? {} : { model: decided.model }),
      ...(decided.effort === undefined ? {} : { effort: decided.effort }),
      part: { value: only.id, applied: 'only-candidate' }
    }
  }
  return { kind: 'ask', tier: decided.modelCandidates.tier, candidates }
}

export interface SettleModelStepInput {
  decided: LaunchDecision
  /** The router's answer to the second request built over `decided.modelCandidates.options`. */
  response: JevModelAnswers | JevRouteFallback
  effortScore: number
  profile: JevRoutingProfile
  effortLadders?: EffortLadders
}

/**
 * The second request's decision (ADR-028 item 2): candidates that cannot honour the effort ceiling
 * are removed before `selectModelWinner`, each keeping the index it was sent under; with none left
 * the step falls back with `'effort-ceiling'`. A router fallback, or an answer no winner can be
 * read from, settles on the safe default with its reason.
 */
export function settleModelStep(
  input: SettleModelStepInput
): SettledModel | { kind: 'fallback'; reason: 'effort-ceiling' } {
  const { decided, response } = input
  if (response.kind === 'fallback') return safeDefaultModel(decided, response.reason)

  const sent: ModelSelectionCandidate[] = decided.modelCandidates.options.map(
    (candidate, index) => ({ key: String(index), id: candidate.id, entry: candidate.entry })
  )
  const eligible = eligibleCandidates(
    decided.provider,
    sent,
    input.effortScore,
    input.effortLadders
  )
  if (eligible.length === 0) return { kind: 'fallback', reason: 'effort-ceiling' }

  const selection = selectModelWinner(eligible, response.fits, response.choice, input.profile)
  if (selection === undefined) return safeDefaultModel(decided, 'invalid-response')

  const finalized = finalizeModel(
    decided.provider,
    selection.candidate.id,
    selection.candidate.entry,
    input.effortScore,
    input.effortLadders
  )
  // The same belt-and-braces discipline `finalizeModel` holds for the first request's own pick.
  if (finalized === undefined) return safeDefaultModel(decided, 'invalid-response')

  return {
    kind: 'model',
    model: finalized.model,
    ...(finalized.effort === undefined ? {} : { effort: finalized.effort }),
    part: {
      value: finalized.model,
      applied: 'answered',
      probability: selection.probability,
      ...(selection.choiceProbability === undefined
        ? {}
        : { choiceProbability: selection.choiceProbability })
    }
  }
}

/**
 * The overall confidence of a decision with its model part: the MIN over every part actually
 * answered (provider and tier from the first request, the model from the second), `undefined` when
 * none was. An `'only-candidate'` or `'safe-default'` model is excluded: nothing was answered.
 */
export function overallConfidence(decided: LaunchDecision, part: JevModelPart): number | undefined {
  return minOfAnswered(
    decided.confidence,
    part.applied === 'answered' ? part.probability : undefined
  )
}
