// 06 §12: the jev value objects. `JevSuggestion` is transient and never persisted (INV-87); seam A
// carries it as `JevSuggestionView = JevSuggestion` (14 §3.6). Each type is copied field for field
// from 06 §12 (the wire copy is `contracts/wire/imported.ts`, which this domain may not import, R1);
// on any difference the owner wins. Pure types: no I/O, no clock read (05 §2.2, R1).
import type { JevFallbackReason } from '../../../kernel/domain/sharedContracts'
import type { ProviderId } from '../../../kernel/domain/values'

/** 06 §12: the ADR-020 D2 list plus `'effort-ceiling'` (ADR-028 D2); owned once, in the kernel. */
export type { JevFallbackReason }

/** 06 §12 `JevRoutingProfile` (US-SET-007; glossary). */
export type JevRoutingProfile = 'economy' | 'balanced' | 'premium'

/** 06 §12: the default routing profile. */
export const DEFAULT_JEV_ROUTING_PROFILE: JevRoutingProfile = 'balanced'

/** Jev's own confidence tier of a pick: a routing tier, never `Mine.tier` (06 §12). */
export type JevModelTier = 'fast-cheap' | 'balanced' | 'frontier' | 'long-context'

/** Where a suggested part came from: Jev answered it, or it fell back to a safe value (06 §12 `parts`). */
export type JevPartOrigin = 'answered' | 'safe-default'

/**
 * 06 §12 `JevSuggestion` (VO, transient, never persisted, INV-87). It names no permission mode and
 * carries no reason sentence or fallback supplier. The parts are the pick's own four: supplier,
 * model, effort, tier.
 * - `confidence` is per part: how sure Jev was of each part it answered, a fraction in [0, 1]; a
 *   part Jev did not answer has none.
 * - `parts` is answered vs fallen back: each part present in the pick with its origin.
 * - `truncated`: the prompt sent to Jev was itself trimmed to fit its request budget.
 * - `flags` (AMENDMENT-22): Jev's trivial and large-context answers; absent when Jev answered no
 *   part, so a fallback suggestion carries none.
 */
export interface JevSuggestion {
  providerId?: ProviderId
  model?: string
  effort?: string
  tier?: JevModelTier
  confidence: { providerId?: number; model?: number; effort?: number; tier?: number }
  truncated: boolean
  parts: {
    providerId?: JevPartOrigin
    model?: JevPartOrigin
    effort?: JevPartOrigin
    tier?: JevPartOrigin
  }
  fallback?: JevFallbackReason
  flags?: { trivial: boolean; largeContext: boolean }
}
