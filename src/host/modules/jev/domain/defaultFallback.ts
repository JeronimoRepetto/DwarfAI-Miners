// ADR-028 items 2-3 (OQ-38 B): when no candidate can honour the effort ceiling on a normal launch,
// the fallback suggestion carries the person's configured Default provider, model and effort
// (US-SET-008), which the launch hands back to the pickers. The default is the person's own, not
// Jev's pick, so it is never passed through `capEffort` (ADR-028 item 3; INV-86 binds Jev's pick
// only). With Default provider "None" (no `provider`, 09 §4.8) there is nothing to hand back: the
// caller answers `jev-could-not-choose`. Pure: no I/O, no clock read (05 §2.2, R1).
import type { RoutingLaunchDefault } from './routeDecision'
import type { JevSuggestion } from './suggestion'

/** The decision this applies to: every candidate was above the effort ceiling (ADR-028 item 2). */
export interface EffortCeilingFallback {
  kind: 'fallback'
  reason: 'effort-ceiling'
}

/** The fallback suggestion, or `'no-default'` when Default provider is "None". */
export type DefaultFallback = JevSuggestion | 'no-default'

/**
 * Each configured part is carried as is and marked `safe-default` (06 §12 `parts`: not Jev's
 * answer), with no confidence: Jev answered none of it. A model or effort without a provider is
 * never a default (09 §4.8).
 */
export function defaultFallback(
  decision: EffortCeilingFallback,
  defaults: RoutingLaunchDefault
): DefaultFallback {
  if (defaults.provider === undefined) return 'no-default'
  const suggestion: JevSuggestion = {
    providerId: defaults.provider,
    confidence: {},
    truncated: false,
    parts: { providerId: 'safe-default' },
    fallback: decision.reason
  }
  if (defaults.model !== undefined) {
    suggestion.model = defaults.model
    suggestion.parts.model = 'safe-default'
  }
  if (defaults.effort !== undefined) {
    suggestion.effort = defaults.effort
    suggestion.parts.effort = 'safe-default'
  }
  return suggestion
}
