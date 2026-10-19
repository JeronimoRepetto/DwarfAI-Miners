// Every catalog provider's capability table (#509, jev-routing-profiles T1), transplanted from the
// found tree's `src/main/jev/capabilities/modelCapability.ts`; the entry types live in
// `modelCapabilityEntry.ts`. Pure data: no I/O, no clock read (05 §2.2, R1).
import type { ProviderId } from '../../../../kernel/domain/values'
import { ANTIGRAVITY_MODEL_CAPABILITIES } from './antigravity'
import { CLAUDE_MODEL_CAPABILITIES } from './claude'
import { CODEX_MODEL_CAPABILITIES } from './codex'
import type { ModelCapabilityEntry, ModelCapabilityLookup } from './modelCapabilityEntry'
import { OPENCODE_CAPABILITY_OVERLAY } from './opencode'

export type {
  JevCapabilityTable,
  ModelCapabilityEntry,
  ModelCapabilityLookup,
  ModelTier
} from './modelCapabilityEntry'

/**
 * Every provider's own capability table, assembled from the per-provider
 * files so each one stays independently reviewable and independently wrong
 * (a mistake in `codex.ts` cannot silently affect `claude.ts`'s entries).
 *
 * `opencode` here is the CURATED OVERLAY ONLY (#547) — `OPENCODE_CAPABILITY_
 * OVERLAY` from `opencode.ts`, empty today. Unlike the other three providers,
 * OpenCode's REAL per-install table is DERIVED at route time from its own
 * live catalogue (`opencodeDerived.ts`'s `deriveOpenCodeCapabilities`,
 * merged with this overlay by `mergeOpenCodeCapabilityTable`) — a static
 * table for a catalogue that differs per install and moves with models.dev
 * would be stale on arrival. `routeLaunch.ts` assembles the real table and
 * injects it into `buildJevRouteRequest`/`decideLaunch`; this module's own
 * `MODEL_CAPABILITIES` constant is read directly only for claude/codex/
 * antigravity, and only for the overlay's own shape where OpenCode is
 * concerned (`lookupModelCapability`/`capabilities.test.ts`'s generic
 * exhaustiveness loop do not — and were never meant to — resolve a DERIVED
 * OpenCode id; see `capabilities.test.ts`'s own OpenCode section for that).
 */
export const MODEL_CAPABILITIES: Readonly<
  Record<ProviderId, Readonly<Record<string, ModelCapabilityEntry>>>
> = {
  claude: CLAUDE_MODEL_CAPABILITIES,
  codex: CODEX_MODEL_CAPABILITIES,
  antigravity: ANTIGRAVITY_MODEL_CAPABILITIES,
  opencode: OPENCODE_CAPABILITY_OVERLAY,
  // The simulated provider (15 §4.12) offers no models.
  simulated: {}
}

/**
 * What this table knows about one (provider, model) pair — never throws, and
 * never guesses at an entry for an id it was not given evidence for. T3 reads
 * `{ kind: 'unknown' }` as "route on tier/provider alone, name nothing about
 * this model", the same degrade-rather-than-refuse shape the rest of the Jev
 * routing pipeline already holds to (`buildJevRouteRequest`'s own skip kinds).
 */
export function lookupModelCapability(
  provider: ProviderId,
  modelId: string
): ModelCapabilityLookup {
  return MODEL_CAPABILITIES[provider]?.[modelId] ?? { kind: 'unknown' }
}
