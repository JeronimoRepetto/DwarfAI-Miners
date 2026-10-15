// The capability-entry types every per-provider table shares, apart from the assembled table
// (modelCapability.ts) so a provider file never imports the module that imports it (R5).
import type { ProviderId } from '../../../../kernel/domain/values'

/**
 * A model's capability tier (jev-routing-profiles T3). `'special-purpose'` is a capability-table
 * concept only: a routing decision never lands on it.
 */
export type ModelTier = 'fast-cheap' | 'balanced' | 'frontier' | 'long-context' | 'special-purpose'

/**
 * What Jev is allowed to know about a model (#509 follow-up, jev-routing-profiles
 * T1) — the table T3's `model_tier` mapping reads instead of the model's own
 * name. Names alone flatten Jev's answer distribution (near-identical option
 * text is a calibrated matcher's known failure mode, per the consistency
 * cookbook), so every fact a routing decision needs has to be spelled out
 * here in words, sourced, and dated.
 *
 * Every field traces to the provider's own official documentation or to the
 * installed CLI's own output — never a third-party summary, and never a
 * guess dressed as a fact. A field this app could not verify is
 * `relativeCost: 'unverified'` (never omitted, since Jev's cost tiebreak
 * still needs an answer for every option) or left off entirely when the
 * field itself is optional (`contextWindowTokens`, `alias`).
 */

/**
 * One model's whole answer to "what is it for". `what`/`notFor`/`examples`
 * are written as criteria Jev matches a prompt's `state` against (T3), so
 * they never restate the model's own name — a routing question that named
 * the option inside its own criteria would be circular, answering "is this
 * the right model" with "this is the model".
 */
export interface ModelCapabilityEntry {
  tier: ModelTier
  /** What kind of work this model is FOR, in words a prompt can be matched against. */
  what: string
  /** What this model is a poor fit for — the contrastive half `what` alone cannot carry. */
  notFor: string
  /** Exactly two short example prompts this model would be the right answer for. */
  examples: readonly [string, string]
  /** False for a catalogue entry that must never be offered as a launch choice (e.g. a hidden internal reviewer). */
  launchTarget: boolean
  /**
   * The levels of THIS provider's own effort ladder (`PROVIDER_EFFORT_LEVELS`
   * in `launchTuning.ts`) this model accepts — `'all'` when nothing narrows
   * it below the provider's full ladder, `[]` when the model takes no effort
   * level at all (Haiku). Never a level outside that ladder: the same rule
   * `ModelOption.effortLevels` already holds at the wire.
   */
  effortLevels: readonly string[] | 'all'
  /** Tokens, from the provider's own documented context window. Omitted when unverified. */
  contextWindowTokens?: number
  /** Coarse price band, judged against the other entries in this table — never an exact figure. */
  relativeCost: 'low' | 'medium' | 'high' | 'very-high' | 'unverified'
  /** What this id resolves to, in words — present only for an id that IS an alias rather than a pinned model. */
  alias?: string
  /** Official documentation URLs, or `'installed CLI: <command or path>'` for a fact read off this machine's own binary. */
  sources: readonly string[]
  /** The date this entry's facts were last checked against its sources. */
  verifiedOn: string
}

/** `lookupModelCapability`'s honest "I don't know this one" — never thrown, always returned. */
export type ModelCapabilityLookup = ModelCapabilityEntry | { kind: 'unknown' }

/** The capability table shape the request builder and `decideLaunch` read, injected rather than imported. */
export type JevCapabilityTable = Readonly<
  Record<ProviderId, Readonly<Record<string, ModelCapabilityEntry>>>
>
