import { PROVIDER_EFFORT_LEVELS, parseLaunchTuning } from '../domain/launchTuning'
import {
  DWARF_PROVIDERS,
  isDwarfProvider,
  type AgentModelCatalog,
  type AgentProviderOption,
  type DwarfProvider,
  type JevLaunchDefault,
  type JevRoutingProfile,
  type ModelTier
} from '../domain/types'
import type { ModelCapabilityEntry } from './capabilities/modelCapability'
import type { JevRouteAnswers } from './jevRouterPort'
import { TIER_CHOICE_TO_MODEL_TIER, mapEffortScore } from './routeRequest'

/**
 * The LOCAL routing decision (jev-routing-profiles T3): pure, no network —
 * takes Jev's already-answered five questions plus the routing profile, the
 * live launchable providers and catalogues, the capability table, and the
 * user's own configured default, and turns them into ONE concrete provider,
 * model and effort, or says why it could not.
 *
 * Every floor and profile rule below is a PRODUCT DEFAULT (orchestrator
 * decision, 2026-09-21, recorded in `odd/tasks/jev-routing-profiles.md`),
 * meant to be tuned from the JEV_DEBUG trace once real answers are observed
 * — not a measured constant.
 */

/** Below this, the `provider` answer is too unsure to act on — falls to the user's default, then the cheapest launchable provider at the chosen tier. */
export const PROVIDER_CONFIDENCE_FLOOR = 0.6
/** Below this, the `model_tier` answer is too unsure to act on — falls to `'balanced'`, the safe middle. */
export const TIER_CONFIDENCE_FLOOR = 0.7
/** At or above this, `is_trivial` is confident enough to force the `fast-cheap` tier, overriding the profile and the tier answer. */
export const TRIVIAL_FLOOR = 0.75
/** At or above this, `needs_large_context` is confident enough to prefer a large-context-capable entry within the chosen tier. */
export const LARGE_CONTEXT_FLOOR = 0.75

/** The capability table shape `decideLaunch` reads — injected rather than importing `MODEL_CAPABILITIES` directly, so this module stays pure and testable with a small synthetic table. */
export type JevCapabilityTable = Readonly<
  Record<DwarfProvider, Readonly<Record<string, ModelCapabilityEntry>>>
>

/** Tiers a routing decision may ever land on — `'special-purpose'` is a capability-table concept only; see `ModelTier`'s own comment in contracts.ts. */
type RoutingTier = 'fast-cheap' | 'balanced' | 'frontier' | 'long-context'

/**
 * Where a tier steps to when the CHOSEN provider has no launchable,
 * catalogued entry at it — always toward `balanced` then `fast-cheap`, never
 * upward. `'long-context'` steps the same way: no capability table tags
 * anything with that tier today, so in practice it always steps down to
 * `balanced` — an honest, evidence-based outcome, not a special case.
 */
const TIER_STEP_DOWN: Readonly<Record<RoutingTier, readonly RoutingTier[]>> = {
  'fast-cheap': ['fast-cheap'],
  balanced: ['balanced', 'fast-cheap'],
  frontier: ['frontier', 'balanced', 'fast-cheap'],
  'long-context': ['long-context', 'balanced', 'fast-cheap']
}

const COST_RANK: Readonly<Record<ModelCapabilityEntry['relativeCost'], number>> = {
  low: 0,
  medium: 1,
  high: 2,
  'very-high': 3,
  // Sorts LAST — an unverified cost must never look cheaper than a verified one.
  unverified: 4
}

export interface DecideLaunchInput {
  answers: JevRouteAnswers
  profile: JevRoutingProfile
  /** The live launchable set, fetched fresh by the caller — see routeLaunch.ts. */
  providers: readonly AgentProviderOption[]
  /** The live per-provider model catalogues, fetched fresh by the caller. */
  catalogs: readonly AgentModelCatalog[]
  capabilities: JevCapabilityTable
  userDefault: JevLaunchDefault
}

export type JevDecideResult =
  | {
      kind: 'decision'
      provider: DwarfProvider
      model?: string
      effort?: string
      confidence: number
      tier: ModelTier
      parts: {
        provider: { value: DwarfProvider; confidence: number; applied: 'answered' | 'safe-default' }
        tier: { value: ModelTier; confidence: number; applied: 'answered' | 'safe-default' }
        trivial: { value: boolean; probability: number }
        largeContext: { value: boolean; probability: number }
      }
    }
  | { kind: 'fallback'; reason: 'invalid-response' }

/** Whether `value` is one of `TIER_CHOICE_TO_MODEL_TIER`'s own answerable keys (never `'no_preference'`). */
function isAnswerableTierChoice(value: string): value is keyof typeof TIER_CHOICE_TO_MODEL_TIER {
  return Object.prototype.hasOwnProperty.call(TIER_CHOICE_TO_MODEL_TIER, value)
}

/**
 * The launchable provider whose capability table has the cheapest entry at
 * `tier` — the safe default for "no preference, no user default". Falls
 * back to the first launchable provider in the contract's own order when
 * NONE of them has an entry at this exact tier (today: `'long-context'`,
 * which no table tags anything with yet), deterministic rather than
 * arbitrary. `launchableProviders` is never empty here: `buildJevRouteRequest`
 * already skipped with `'no-launchable-provider'` before Jev was ever asked.
 */
function cheapestLaunchableProviderFor(
  tier: RoutingTier,
  launchableProviders: ReadonlySet<DwarfProvider>,
  capabilities: JevCapabilityTable
): DwarfProvider {
  let best: { provider: DwarfProvider; rank: number } | undefined
  for (const provider of DWARF_PROVIDERS) {
    if (!launchableProviders.has(provider)) continue
    for (const capEntry of Object.values(capabilities[provider] ?? {})) {
      if (!capEntry.launchTarget || capEntry.tier !== tier) continue
      const rank = COST_RANK[capEntry.relativeCost]
      if (best === undefined || rank < best.rank) best = { provider, rank }
    }
  }
  if (best !== undefined) return best.provider
  const first = DWARF_PROVIDERS.find((provider) => launchableProviders.has(provider))
  if (first === undefined) {
    throw new Error(
      'decideLaunch: no launchable provider — buildJevRouteRequest should have skipped earlier'
    )
  }
  return first
}

/**
 * The concrete model for one provider, stepping down from `tier` toward
 * `balanced`/`fast-cheap` until a launchable, LIVE-CATALOGUED entry is
 * found. Within one step, `needsLargeContext` narrows to entries with a
 * documented ≥1,000,000-token window (or tagged `'long-context'` outright);
 * if that narrowing finds nothing, the ordinary candidates at that same
 * step are used instead — large context is a PREFERENCE within the tier,
 * never a reason to step past it.
 */
function pickModel(options: {
  table: Readonly<Record<string, ModelCapabilityEntry>>
  tier: RoutingTier
  profile: JevRoutingProfile
  needsLargeContext: boolean
  liveModelIds: ReadonlySet<string>
}): { id: string; entry: ModelCapabilityEntry } | undefined {
  for (const stepTier of TIER_STEP_DOWN[options.tier]) {
    const atTier = Object.entries(options.table).filter(
      ([, capEntry]) => capEntry.launchTarget && capEntry.tier === stepTier
    )
    let candidates = atTier
    if (options.needsLargeContext) {
      const preferred = atTier.filter(
        ([, capEntry]) =>
          (capEntry.contextWindowTokens ?? 0) >= 1_000_000 || capEntry.tier === 'long-context'
      )
      if (preferred.length > 0) candidates = preferred
    }
    const live = candidates.filter(([id]) => options.liveModelIds.has(id))
    if (live.length === 0) continue
    const sorted = [...live].sort(
      ([, a], [, b]) => COST_RANK[a.relativeCost] - COST_RANK[b.relativeCost]
    )
    const [id, capEntry] = options.profile === 'premium' ? sorted[sorted.length - 1]! : sorted[0]!
    return { id, entry: capEntry }
  }
  return undefined
}

/**
 * Narrows a mapped effort level to the nearest one the CHOSEN MODEL's own
 * `effortLevels` actually accepts. `mapEffortScore` only knows the
 * provider's FULL ladder, and a model narrower than that (Codex's
 * `gpt-5.6-luna`, no `ultra`) would otherwise be asked for a level it
 * silently ignores (`applyFlagSettings` resolves cleanly and does nothing —
 * the same trap `ModelOption.effortLevels`'s own comment names). `'all'`
 * keeps the mapped level unchanged; `[]` accepts none. "Nearest" is by INDEX
 * on the provider's own full ladder — the same scale `mapEffortScore`
 * positions the rubric score on — with ties broken toward the lower index.
 */
function narrowEffort(
  fullLadder: readonly string[],
  allowed: readonly string[] | 'all',
  mapped: string
): string | undefined {
  if (allowed === 'all') return mapped
  if (allowed.length === 0) return undefined
  if (allowed.includes(mapped)) return mapped
  const mappedIndex = fullLadder.indexOf(mapped)
  if (mappedIndex === -1) return allowed[0]
  let nearest = allowed[0]!
  let nearestDistance = Math.abs(fullLadder.indexOf(nearest) - mappedIndex)
  for (const level of allowed) {
    const distance = Math.abs(fullLadder.indexOf(level) - mappedIndex)
    if (distance < nearestDistance) {
      nearest = level
      nearestDistance = distance
    }
  }
  return nearest
}

/** The local decision — see this module's own comment. */
export function decideLaunch(input: DecideLaunchInput): JevDecideResult {
  const { answers, profile, providers, catalogs, capabilities, userDefault } = input

  const launchableProviders = new Set(
    providers.filter((option) => option.launchable).map((option) => option.provider)
  )

  // --- trivial / large-context: floored booleans, independent of everything else.
  const trivialValue = answers.trivial.probability >= TRIVIAL_FLOOR
  const largeContextValue = answers.largeContext.probability >= LARGE_CONTEXT_FLOOR

  // --- tier: a confident trivial answer overrides everything; otherwise the
  // floored tier answer, then the chosen profile's own cap/promotion.
  let tier: RoutingTier
  let tierOverridden: boolean
  if (trivialValue) {
    tier = 'fast-cheap'
    tierOverridden = true
  } else {
    const tierChoice = answers.tier.choice
    if (
      tierChoice !== 'no_preference' &&
      answers.tier.confidence >= TIER_CONFIDENCE_FLOOR &&
      isAnswerableTierChoice(tierChoice)
    ) {
      // Safe: TIER_CHOICE_TO_MODEL_TIER's four keys map onto the four
      // routing tiers only — 'special-purpose' is not one of them (see its
      // own comment in routeRequest.ts).
      tier = TIER_CHOICE_TO_MODEL_TIER[tierChoice] as RoutingTier
      tierOverridden = false
    } else {
      tier = 'balanced'
      tierOverridden = true
    }
    // Economy never reaches above balanced — long-context is left uncapped
    // here on purpose: no capability table currently tags anything
    // `'long-context'`, so it already steps down to balanced/fast-cheap in
    // pickModel regardless of profile, and capping it too would be a rule
    // with no observable effect today, dressed up as a decision.
    if (profile === 'economy' && tier === 'frontier') {
      tier = 'balanced'
      tierOverridden = true
    }
    // Premium promotes a confident balanced answer to frontier, but only for
    // work the effort rubric already calls multi-file or architectural
    // (score >= 2) and never for a trivial prompt (guarded above already,
    // restated here for the reader: trivialValue is always false in this branch).
    if (
      profile === 'premium' &&
      tier === 'balanced' &&
      !trivialValue &&
      answers.effort.score >= 2
    ) {
      tier = 'frontier'
      tierOverridden = true
    }
  }

  // --- provider: the floored provider answer; else the user's own default
  // (when launchable); else the cheapest launchable provider at the tier
  // just resolved.
  let provider: DwarfProvider
  let providerOverridden: boolean
  const answeredProvider = answers.provider.choice
  if (
    answeredProvider !== 'no_preference' &&
    answers.provider.confidence >= PROVIDER_CONFIDENCE_FLOOR &&
    isDwarfProvider(answeredProvider) &&
    launchableProviders.has(answeredProvider)
  ) {
    provider = answeredProvider
    providerOverridden = false
  } else {
    providerOverridden = true
    if (userDefault.provider !== undefined && launchableProviders.has(userDefault.provider)) {
      provider = userDefault.provider
    } else {
      provider = cheapestLaunchableProviderFor(tier, launchableProviders, capabilities)
    }
  }

  // --- concrete model: step down from `tier` until a launchable, live-
  // catalogued entry is found for the chosen provider.
  const liveModelIds = new Set(
    (catalogs.find((catalog) => catalog.provider === provider)?.models ?? []).map(
      (model) => model.value
    )
  )
  const picked = pickModel({
    table: capabilities[provider] ?? {},
    tier,
    profile,
    needsLargeContext: largeContextValue,
    liveModelIds
  })

  // --- effort: the rubric score onto the provider's own ladder, then
  // narrowed to the picked model's own accepted levels. No model, no effort
  // either — the CLI keeps its own default for both, the same "absent
  // degrades" rule LaunchTuning already holds to.
  const providerEffort = mapEffortScore(provider, answers.effort.score, PROVIDER_EFFORT_LEVELS)
  const effort =
    picked === undefined || providerEffort === undefined
      ? undefined
      : narrowEffort(PROVIDER_EFFORT_LEVELS[provider], picked.entry.effortLevels, providerEffort)

  const tuning = parseLaunchTuning(provider, {
    ...(picked === undefined ? {} : { model: picked.id }),
    ...(effort === undefined ? {} : { effort })
  })
  if (tuning === null) {
    // Belt and braces, the same discipline the old routeLaunch.ts already
    // held for a raw Jev answer: a derived model/effort pairing this app's
    // own launch gate would refuse is never carried out. Not reachable
    // through this function's own derivation today (`model` is always a
    // trimmed catalogue id or absent; `effort` is always a member of
    // PROVIDER_EFFORT_LEVELS[provider] or absent) — kept for the day a
    // capability entry's own id or a future ladder change makes it so.
    return { kind: 'fallback', reason: 'invalid-response' }
  }

  return {
    kind: 'decision',
    provider,
    ...(tuning.model === undefined ? {} : { model: tuning.model }),
    ...(tuning.effort === undefined ? {} : { effort: tuning.effort }),
    // The function-calling cookbook's own rule for a multi-part answer: the
    // MIN of the applied parts' confidences, using each part's RAW reported
    // confidence even when a floor or a profile rule overrode its value.
    confidence: Math.min(answers.provider.confidence, answers.tier.confidence),
    tier,
    parts: {
      provider: {
        value: provider,
        confidence: answers.provider.confidence,
        applied: providerOverridden ? 'safe-default' : 'answered'
      },
      tier: {
        value: tier,
        confidence: answers.tier.confidence,
        applied: tierOverridden ? 'safe-default' : 'answered'
      },
      trivial: { value: trivialValue, probability: answers.trivial.probability },
      largeContext: { value: largeContextValue, probability: answers.largeContext.probability }
    }
  }
}
