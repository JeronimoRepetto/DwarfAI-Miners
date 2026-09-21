import type { OpenCodeCatalogueModel } from '../../providers/opencode/models'
import type { ModelCapabilityEntry, ModelTier } from './modelCapability'

/**
 * OpenCode's capability table is DERIVED, not curated (#547) — unlike
 * claude.ts/codex.ts/antigravity.ts, which hand-verify a fixed list against
 * the provider's own documentation, OpenCode's own catalogue changes with
 * every models.dev update and every person's own configured provider keys
 * (`opencode-go`, `opencode`, and whatever else a person's own `auth.json`
 * enables), so a hand-maintained table would be stale on arrival and would
 * not describe the person's own install. This module turns one
 * `opencode models --verbose` read (`providers/opencode/models.ts`) into one
 * `ModelCapabilityEntry` per ACTIVE model, using ONLY the facts that read
 * printed — never invented prose per model (jev-capabilities skill's own
 * evidence rule). `routeLaunch.ts` is where this runs, at route time,
 * against the live catalogue, merged with `opencode.ts`'s curated overlay.
 */

/**
 * Cost bands (#547): `cost.output`, USD per million tokens. Measured across
 * this machine's own catalogue on 2026-09-21 (`opencode models --verbose`,
 * 35 active models) — the distinct `cost.output` values ran from 0 (several
 * free models) to 15 (`opencode-go/kimi-k3`), with natural gaps around 0.5,
 * 2 and 5 (5 values at or below 0.5, 6 more at or below 2, 4 more at or below
 * 5, the remaining 3 above it). Chosen as round, product-legible numbers
 * near those gaps — $0.50 / $2 / $5 per million output tokens — rather than
 * a data-fitted split, so a future catalogue with different prices does not
 * silently redraw the bands underneath a routing decision that already
 * shipped. Written ONCE, here, and cited by every reader of a band.
 */
export const OPENCODE_COST_BAND_THRESHOLDS = {
  /** `cost.output` at or below this is `'low'` — free models included (`cost.output === 0`). */
  low: 0.5,
  /** At or below this, and above `low`, is `'medium'`. */
  medium: 2,
  /** At or below this, and above `medium`, is `'high'`. Above this is `'very-high'`. */
  high: 5
} as const

/** `relativeCost` from `cost.output` per million tokens — see `OPENCODE_COST_BAND_THRESHOLDS`'s own comment for the boundaries and why they are round numbers, not measured percentiles. */
export function opencodeCostBand(
  costOutputPerMillion: number
): ModelCapabilityEntry['relativeCost'] {
  if (costOutputPerMillion <= OPENCODE_COST_BAND_THRESHOLDS.low) return 'low'
  if (costOutputPerMillion <= OPENCODE_COST_BAND_THRESHOLDS.medium) return 'medium'
  if (costOutputPerMillion <= OPENCODE_COST_BAND_THRESHOLDS.high) return 'high'
  return 'very-high'
}

/** The context window `routeDecision.ts`'s own `needsLargeContext` narrowing already treats as "large" (`pickModel`'s `>= 1_000_000` check) — the same number, not a second one. */
const LONG_CONTEXT_TOKENS = 1_000_000

/** The facts `opencodeTier` reads — a subset of `OpenCodeCatalogueModel`, so a caller building a synthetic case for a test need not fill in `value`/`displayName`/`status`/etc. */
export type OpencodeTierFacts = Pick<OpenCodeCatalogueModel, 'cost' | 'limit' | 'capabilities'>

/**
 * `tier` from cost band and `capabilities.reasoning` (#547, written once):
 *
 * 1. Reasoning AND the most expensive band (`'very-high'`) → `'frontier'`.
 * 2. The cheapest band (`'low'`, free included) → `'fast-cheap'` — checked
 *    AHEAD of the context check below, so a free model with a huge context
 *    window still reads as the cheap, fast option it is: `pickModel`'s own
 *    tier-down walk never looks ABOVE the tier it was asked for, so a free
 *    model landing anywhere but `'fast-cheap'` would make every trivial
 *    prompt miss it.
 * 3. A documented context of at least `LONG_CONTEXT_TOKENS`, neither of the
 *    above → `'long-context'`.
 * 4. Otherwise → `'balanced'`.
 *
 * `'special-purpose'` is never assigned here — nothing in this catalogue's
 * own facts singles out a hidden or non-coding model the way Antigravity's
 * `nano-banana-2` is (see jev-capabilities skill); `launchTarget` already
 * excludes an inactive id before this function is ever called.
 */
export function opencodeTier(model: OpencodeTierFacts): ModelTier {
  const band = opencodeCostBand(model.cost.output)
  if (model.capabilities.reasoning && band === 'very-high') return 'frontier'
  if (band === 'low') return 'fast-cheap'
  if (model.limit.context >= LONG_CONTEXT_TOKENS) return 'long-context'
  return 'balanced'
}

const NOT_FOR_BY_TIER: Readonly<Record<ModelTier, string>> = {
  'fast-cheap':
    'Work that needs sustained reasoning across several files, or a hard, unfamiliar problem.',
  balanced:
    'A trivial prompt with no code change, or one that already needs the deepest reasoning or the largest context this catalogue offers.',
  frontier:
    'A trivial or simple prompt, or one a cheaper OpenCode model in this same catalogue already handles.',
  'long-context': 'A prompt that fits comfortably in an ordinary context window.',
  'special-purpose': 'Never assigned to a derived OpenCode entry — see this file’s own tier rule.'
}

const EXAMPLES_BY_TIER: Readonly<Record<ModelTier, readonly [string, string]>> = {
  'fast-cheap': [
    'Rename this variable everywhere it appears in the file.',
    'Add a null check before this property access.'
  ],
  balanced: [
    'Add a new field to this form and wire it through validation.',
    'Extract this duplicated logic into a shared helper.'
  ],
  frontier: [
    'Design the data model for a feature this codebase has never had before.',
    'Untangle a deadlock that only reproduces under real production load.'
  ],
  'long-context': [
    'Review this migration end to end across the whole repository.',
    'Trace where this regression was introduced across the full test history.'
  ],
  'special-purpose': [
    'Never assigned to a derived OpenCode entry — see this file’s own tier rule.',
    'Never assigned to a derived OpenCode entry — see this file’s own tier rule.'
  ]
}

/** `1,048,576` — for a `what` string a person reads, never `1048576`. */
function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US')
}

/** `'$3 in / $15 out per million tokens'`, or `'no per-token cost'` for a free model — the two shapes `cost.input`/`cost.output` can actually take. */
function formatCost(cost: OpenCodeCatalogueModel['cost']): string {
  if (cost.input === 0 && cost.output === 0) return 'no per-token cost'
  return `$${cost.input} in / $${cost.output} out per million tokens`
}

/**
 * `what`, templated from facts only (#547) — reasoning, context window, cost
 * — never the model's own id or display name: `what`/`notFor`/`examples`
 * are Jev-matching criteria, not a label, and a criterion built around the
 * model's own name is the exact mistake the jev-capabilities skill's
 * "Getting it wrong" section names (matching claude.ts's/codex.ts's own
 * precedent, where `what` never restates the id either — the name goes in
 * `alias` when a field for it is warranted at all).
 */
function templatedWhat(model: OpenCodeCatalogueModel): string {
  const reasoningPhrase = model.capabilities.reasoning
    ? 'A reasoning model'
    : 'A non-reasoning model'
  return (
    `${reasoningPhrase} through OpenCode, with a ${formatTokens(model.limit.context)}-token ` +
    `context window, at ${formatCost(model.cost)}.`
  )
}

/** The catalogue command and models.dev, exactly as the jev-capabilities skill's evidence rule requires — cited once, reused by every derived entry. */
export const OPENCODE_CATALOGUE_SOURCES = [
  'installed CLI: opencode models --verbose',
  'https://models.dev'
] as const

/**
 * One `ModelCapabilityEntry` per model whose `status === 'active'` (#547) —
 * an inactive id gets no entry at all rather than `launchTarget: false`: an
 * OpenCode `launchTarget: false` entry today (Codex's `codex-auto-review`,
 * Antigravity's `nano-banana-2`) marks a model that is real and would launch
 * but should never be OFFERED; an inactive OpenCode id is not known to work
 * if launched at all, and this table is rebuilt fresh from the live
 * catalogue on every route call, so a reactivated id simply reappears on its
 * own — there is no maintainer-authored exception to preserve the way there
 * is for the two curated `launchTarget: false` cases above.
 *
 * Keyed by the exact `provider/model` id the catalogue printed (`model.value`,
 * the same id `ModelOption.value` already carries), so `decideLaunch`'s own
 * live-catalogue id check (`pickModel`'s `liveModelIds`) lines up without
 * translation.
 */
export function deriveOpenCodeCapabilities(
  models: readonly OpenCodeCatalogueModel[],
  readAtIso: string
): Record<string, ModelCapabilityEntry> {
  const table: Record<string, ModelCapabilityEntry> = {}
  for (const model of models) {
    if (model.status !== 'active') continue
    const tier = opencodeTier(model)
    table[model.value] = {
      tier,
      what: templatedWhat(model),
      notFor: NOT_FOR_BY_TIER[tier],
      examples: EXAMPLES_BY_TIER[tier],
      launchTarget: true,
      effortLevels: [...model.effortLevels],
      contextWindowTokens: model.limit.context,
      relativeCost: opencodeCostBand(model.cost.output),
      sources: OPENCODE_CATALOGUE_SOURCES,
      verifiedOn: readAtIso
    }
  }
  return table
}
