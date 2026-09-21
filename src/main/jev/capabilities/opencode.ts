import type { ModelCapabilityEntry } from './modelCapability'

/**
 * OpenCode's curated EXCEPTION list (#547) — most of its table is DERIVED at
 * route time from the live catalogue (`opencodeDerived.ts`); this file
 * exists only for an id a maintainer has hand-verified well enough to
 * replace the derived template with real, sourced prose, in the same shape
 * `claude.ts`/`codex.ts`/`antigravity.ts` already use.
 *
 * Empty today: no OpenCode id has been hand-verified against its own
 * upstream documentation the way Claude's and Codex's entries are (the
 * jev-capabilities skill's own evidence rule — a provider-run catalogue
 * entry, already sourced to `opencode models --verbose` and models.dev by
 * `opencodeDerived.ts`, is not itself grounds for an overlay override; an
 * overlay earns its place by adding something the derived facts alone could
 * not state, e.g. a maintainer's own tested judgment of a model's fit). An
 * empty table is the honest starting point, not a gap waiting to be filled —
 * see `mergeOpenCodeCapabilityTable`'s own comment for how an entry added
 * here later takes precedence.
 */
export const OPENCODE_CAPABILITY_OVERLAY: Readonly<Record<string, ModelCapabilityEntry>> = {}

/**
 * The derived table with the curated overlay's own entries substituted in,
 * per id (#547) — the overlay always wins, since it is the hand-verified
 * exception the derived template exists to be replaced by. Spread order is
 * the whole rule: `overlay` last. `overlay` defaults to
 * `OPENCODE_CAPABILITY_OVERLAY` so a caller assembling the real per-install
 * table (`routeLaunch.ts`) need not import it separately.
 */
export function mergeOpenCodeCapabilityTable(
  derived: Readonly<Record<string, ModelCapabilityEntry>>,
  overlay: Readonly<Record<string, ModelCapabilityEntry>> = OPENCODE_CAPABILITY_OVERLAY
): Readonly<Record<string, ModelCapabilityEntry>> {
  return { ...derived, ...overlay }
}
