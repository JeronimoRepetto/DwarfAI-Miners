// Builds the `LaunchFailure` a failed launch carries (ADR-020 items 1, 2, 6). Pure (05 §2.2, R1).
import type {
  JevFallbackReason,
  LaunchFailure,
  LaunchFailureCause
} from '../../../kernel/domain/sharedContracts'
import { failureActions } from './failureActions'

/** ADR-020 item 6: the tail sent with causes 2 and 3 is the last 400 characters. */
export const TOOL_OUTPUT_TAIL_MAX_CHARS = 400

/** ADR-020 item 2: the one fixed cause-5 sentence the ADR gives (design row `293bc1d:docs/decisions.md:120`). */
export const NO_LAUNCHABLE_PROVIDER_SENTENCE = 'No launchable provider to choose from.'

/**
 * ⟦COPY NEEDED: S-020-2 cause-5 reason sentence⟧ — design owns one fixed sentence per
 * `JevFallbackReason` (ADR-020 Consequences "Copy"); this marked key is never shipped text.
 */
export const CAUSE_5_REASON_SENTENCE_PLACEHOLDER = '⟦COPY NEEDED: S-020-2 cause-5 reason sentence⟧'

export interface LaunchFailureFacts {
  cause: LaunchFailureCause
  supplierLabel: string
  jevReason?: JevFallbackReason // kept for causes 4 and 5 only
  toolOutputTail?: string // kept for causes 2 and 3 only (INV-55)
}

export function buildLaunchFailure(facts: LaunchFailureFacts): LaunchFailure {
  const { cause, supplierLabel, jevReason, toolOutputTail } = facts
  const failure: LaunchFailure = {
    cause,
    supplierLabel,
    actions: failureActions(cause, jevReason)
  }
  const jevCause = cause === 'jev-unreachable' || cause === 'jev-could-not-choose'
  if (jevCause && jevReason !== undefined) failure.jevReason = jevReason
  if (cause === 'jev-could-not-choose') {
    failure.reasonSentence =
      jevReason === 'no-launchable-provider'
        ? NO_LAUNCHABLE_PROVIDER_SENTENCE
        : CAUSE_5_REASON_SENTENCE_PLACEHOLDER
  }
  const tailCause = cause === 'exited-at-once' || cause === 'could-not-start'
  if (tailCause && toolOutputTail !== undefined) {
    failure.toolOutputTail = toolOutputTail.slice(-TOOL_OUTPUT_TAIL_MAX_CHARS)
  }
  return failure
}
