// The actions each launch failure cause allows (ADR-020 items 1–2; 07 S5.08a, S5.08b, S5.14–S5.20).
// Pure (05 §2.2, R1).
import type {
  JevFallbackReason,
  LaunchFailure,
  LaunchFailureCause
} from '../../../kernel/domain/sharedContracts'

export type LaunchFailureAction = LaunchFailure['actions'][number]

/**
 * Causes 1–3 had a supplier (or the custom command) chosen already, so only Retry (US-LAUNCH-006.AC08);
 * `jev-unreachable` is retryable and can be picked by hand; `jev-could-not-choose` can only be picked by
 * hand, and with `no-launchable-provider` there is nothing to pick (ADR-020 item 2).
 */
export function failureActions(
  cause: LaunchFailureCause,
  jevReason?: JevFallbackReason
): ReadonlyArray<LaunchFailureAction> {
  switch (cause) {
    case 'not-installed':
    case 'exited-at-once':
    case 'could-not-start':
      return ['retry']
    case 'jev-unreachable':
      return ['retry', 'pick-manually']
    case 'jev-could-not-choose':
      return jevReason === 'no-launchable-provider' ? [] : ['pick-manually']
  }
}
