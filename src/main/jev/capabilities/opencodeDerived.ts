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
 *
 * #608 T1 (precondition for the issue's own second Jev request, a Noul per
 * candidate model): `notFor`/`examples` used to be keyed BY TIER alone, so
 * two models sharing a tier got byte-identical criteria text — a calibrated
 * matcher's own known failure mode, measured at 0.38 confidence over eleven
 * near-identical options. `templatedWhat`/`notForWithOutputCeiling` below
 * now also read `limit.output`, `cost.cacheRead` and `effortLevels` — every
 * one already parsed by `models.ts`, none of them new I/O — so two same-tier
 * models differ in text whenever they differ in any parsed fact, not only
 * in reasoning/context/cost. `examples` stays tier-generic on purpose; see
 * that constant's own comment for why.
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

/**
 * Deliberately still keyed BY TIER, not per model (#608 T1). `what`/`notFor`
 * gained per-model facts above because the catalogue documents per-model
 * facts to build them from (`limit.output`, `cost.cacheRead`,
 * `effortLevels`); two SHORT EXAMPLE PROMPTS a task would fit have no such
 * source — this catalogue names costs and limits, never worked examples of
 * "what someone would type" for one model over its same-tier sibling, and
 * inventing one would be exactly the "never invent per-model prose" the
 * jev-capabilities skill's evidence rule forbids. A prompt this capable
 * genuinely fits every model in its own tier equally well, so the tier's own
 * two examples stay honest here rather than staging a false per-model
 * contrast the facts do not support.
 */
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

/**
 * `'$3 in / $15 out per million tokens, cached input at $0.3 per million
 * tokens'`, or `'no per-token cost'` for a free model — `cost.cacheRead` is
 * appended only when the catalogue's own block named one (#608 T1: two
 * same-tier, same-price models can still differ here, e.g. `kimi-k3` vs
 * `glm-5.1` in this file's own test fixture). A free model's early return
 * never reaches the cache clause: `cost.input`/`cost.output` both `0` means
 * nothing here costs anything, cached or not.
 */
function formatCost(cost: OpenCodeCatalogueModel['cost']): string {
  if (cost.input === 0 && cost.output === 0) return 'no per-token cost'
  const cache =
    cost.cacheRead === undefined ? '' : `, cached input at $${cost.cacheRead} per million tokens`
  return `$${cost.input} in / $${cost.output} out per million tokens${cache}`
}

/** `'up to 131,072 tokens in a single reply'` — the documented per-turn output ceiling (`limit.output`), never inferred from `limit.context`. */
function formatOutputLimit(outputTokens: number): string {
  return `up to ${formatTokens(outputTokens)} tokens in a single reply`
}

/**
 * `'a low/high/max reasoning-effort ladder to tune'`, or the honest opposite
 * for an empty `variants` map — built from the catalogue's own `variants`
 * keys (`OpenCodeCatalogueModel.effortLevels`), never a level this model's
 * own block did not name (#608 T1). Worth stating in `what` on its own,
 * beyond what `ModelCapabilityEntry.effortLevels` already carries as a
 * separate field: two same-tier models can share reasoning, cost and
 * context exactly and still differ only in whether they take effort tuning
 * at all — this file's own `TWIN_VERBOSE` test fixture is built to prove
 * exactly that case.
 */
function formatEffortLevels(levels: readonly string[]): string {
  if (levels.length === 0) return 'a single fixed effort level, with no ladder to tune'
  return `a ${levels.join('/')} reasoning-effort ladder to tune`
}

/**
 * `what`, templated from facts only (#547, extended #608 T1) — reasoning,
 * context window, output ceiling, cost (with cache pricing when the
 * catalogue names one) and the effort ladder — never the model's own id,
 * display name, `family` or provider slug: `what`/`notFor`/`examples` are
 * Jev-matching criteria, not a label, and a criterion built around the
 * model's own name is the exact mistake the jev-capabilities skill's
 * "Getting it wrong" section names (matching claude.ts's/codex.ts's own
 * precedent, where `what` never restates the id either — the name goes in
 * `alias` when a field for it is warranted at all). `family` is excluded on
 * the same terms even though the raw `opencode models --verbose` block
 * carries it (`docs/opencode-format.md` Row 6): it is a lineage label, not a
 * capability fact, and reads exactly like a second name to a matcher that
 * must never see one.
 *
 * Every clause here traces to a field `models.ts` already parses
 * (`OpenCodeCatalogueModel`) — no new parsing needed for #608 T1, since
 * `limit.output`, `cost.cacheRead` and `effortLevels` were already read off
 * the same `--verbose` block, just never rendered. Two same-tier models with
 * identical reasoning/context/cost (this file's own `TWIN_VERBOSE` fixture)
 * differ ONLY through the output ceiling and the effort-ladder clauses added
 * here — the #608 precondition this task exists to close.
 */
function templatedWhat(model: OpenCodeCatalogueModel): string {
  const reasoningPhrase = model.capabilities.reasoning
    ? 'A reasoning model'
    : 'A non-reasoning model'
  return (
    `${reasoningPhrase} through OpenCode, with a ${formatTokens(model.limit.context)}-token ` +
    `context window and ${formatOutputLimit(model.limit.output)}, at ${formatCost(model.cost)}. ` +
    `It offers ${formatEffortLevels(model.effortLevels)}.`
  )
}

/**
 * The tier's own shared `notFor` sentence, plus this model's real output
 * ceiling (#608 T1) — the one per-model contrast the catalogue's facts can
 * add truthfully without inventing a fact this table has no evidence for
 * (no `attachment`/`tool_call`/`temperature` sub-field is documented
 * anywhere this catalogue has actually been read — `docs/opencode-format.md`
 * Row 6 names the FULL top-level key set measured, and `capabilities` was
 * only ever observed to carry `reasoning`). Two same-tier models whose
 * `notFor` would otherwise be byte-identical (#547's own precondition) still
 * differ here whenever their documented `limit.output` differs.
 */
function notForWithOutputCeiling(tier: ModelTier, outputTokens: number): string {
  return (
    `${NOT_FOR_BY_TIER[tier]} Not for a single reply beyond this model's own ` +
    `${formatTokens(outputTokens)}-token output limit either.`
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
      notFor: notForWithOutputCeiling(tier, model.limit.output),
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
