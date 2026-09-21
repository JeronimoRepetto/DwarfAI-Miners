import type { DwarfProvider } from '../../domain/types'
import { ANTIGRAVITY_MODEL_CAPABILITIES } from './antigravity'
import { CLAUDE_MODEL_CAPABILITIES } from './claude'
import { CODEX_MODEL_CAPABILITIES } from './codex'

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

/** How a model earns a place in a routing profile, independent of its name. */
export type ModelTier = 'fast-cheap' | 'balanced' | 'frontier' | 'long-context' | 'special-purpose'

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

/**
 * Every provider's own capability table, assembled from the per-provider
 * files so each one stays independently reviewable and independently wrong
 * (a mistake in `codex.ts` cannot silently affect `claude.ts`'s entries).
 *
 * `opencode` is empty on purpose: it carries no model catalogue and no
 * launch path (#444), so nothing could ever be looked up for it — an empty
 * table is the honest answer, not a gap waiting to be filled.
 */
export const MODEL_CAPABILITIES: Readonly<
  Record<DwarfProvider, Readonly<Record<string, ModelCapabilityEntry>>>
> = {
  claude: CLAUDE_MODEL_CAPABILITIES,
  codex: CODEX_MODEL_CAPABILITIES,
  antigravity: ANTIGRAVITY_MODEL_CAPABILITIES,
  opencode: {}
}

/**
 * What this table knows about one (provider, model) pair — never throws, and
 * never guesses at an entry for an id it was not given evidence for. T3 reads
 * `{ kind: 'unknown' }` as "route on tier/provider alone, name nothing about
 * this model", the same degrade-rather-than-refuse shape the rest of the Jev
 * routing pipeline already holds to (`buildJevRouteRequest`'s own skip kinds).
 */
export function lookupModelCapability(
  provider: DwarfProvider,
  modelId: string
): ModelCapabilityLookup {
  return MODEL_CAPABILITIES[provider][modelId] ?? { kind: 'unknown' }
}
