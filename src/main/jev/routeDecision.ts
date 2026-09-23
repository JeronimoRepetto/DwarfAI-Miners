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
 * #608: the same run-to-run Noul probability SPREAD TypeSafe's own
 * consistency cookbook measured (`consistency_noul_cookbook.md`: mean
 * per-question probability standard deviation `0.0102` across 15 repeats of
 * the identical question) — doubled into a TIE BAND, so two candidates whose
 * Noul answers differ by less than roughly two standard deviations of that
 * measured noise are treated as indistinguishable rather than as a clear
 * winner. Below this gap, `selectModelWinner` lets the Choice's own
 * probabilities decide among the tied candidates instead.
 */
export const MODEL_TIE_BAND = 0.02

/**
 * The function-calling cookbook's own rule for a multi-part answer,
 * generalized to any number of parts: the MIN over whichever were actually
 * given, ignoring `undefined` (a part that was never answered, or fell back
 * to a safe default) rather than letting its number drag the result down.
 * `undefined` when nothing was given at all — the honest "no part was
 * answered" case #608's own bug report named (a discarded 0.19 provider
 * confidence dragging the whole card down), rather than a misleading
 * number. Used by `decideLaunch`'s own `confidence` (provider/tier) and by
 * `routeLaunch.ts`'s final wire confidence (provider/tier/model together).
 */
export function minOfAnswered(...values: (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined)
  return defined.length === 0 ? undefined : Math.min(...defined)
}

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
      /** MIN over the {provider, tier} parts actually `applied: 'answered'` — see `minOfAnswered`. `undefined` when neither was. */
      confidence?: number
      tier: ModelTier
      parts: {
        provider: { value: DwarfProvider; confidence: number; applied: 'answered' | 'safe-default' }
        tier: { value: ModelTier; confidence: number; applied: 'answered' | 'safe-default' }
        trivial: { value: boolean; probability: number }
        largeContext: { value: boolean; probability: number }
      }
      /**
       * #608: every live, launchable candidate at the tier `candidatesAtTier`
       * actually landed on for the chosen provider, after its own step-down
       * walk — `routeLaunch.ts`'s own input for the second Jev request.
       * `tier` here is the STEP actually used, which can read lower than
       * `tier` above when the routing decision's own tier had no live entry
       * (the same honest distinction `candidatesAtTier`'s own doc comment
       * already draws) — the fit question must ask about the tier a
       * candidate genuinely occupies, not the one nothing at is live.
       * `options` is empty, at the originally resolved `tier`, when nothing
       * lives at any step — the same case that already leaves `model`
       * undefined above.
       */
      modelCandidates: {
        tier: ModelTier
        options: readonly { id: string; entry: ModelCapabilityEntry }[]
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
 * Every live, launchable candidate at the FIRST non-empty step of `tier`'s
 * own `TIER_STEP_DOWN` chain — the step-down walk `decideLaunch`'s own local
 * model pick and its `modelCandidates` (#608) both need, written once so a
 * future change to the walk cannot make the two disagree about what "the
 * tier's own candidates" means. Within one step, `needsLargeContext`
 * narrows to entries with a documented ≥1,000,000-token window (or tagged
 * `'long-context'` outright); if that narrowing finds nothing, the ordinary
 * candidates at that same step are returned instead — large context is a
 * PREFERENCE within the tier, never a reason to step past it. `undefined`
 * when every step is empty.
 */
function candidatesAtTier(options: {
  table: Readonly<Record<string, ModelCapabilityEntry>>
  tier: RoutingTier
  needsLargeContext: boolean
  liveModelIds: ReadonlySet<string>
}):
  | { tier: RoutingTier; options: readonly { id: string; entry: ModelCapabilityEntry }[] }
  | undefined {
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
    return { tier: stepTier, options: live.map(([id, capEntry]) => ({ id, entry: capEntry })) }
  }
  return undefined
}

/**
 * The cheapest candidate for `'economy'`/`'balanced'`, or the priciest for
 * `'premium'` — the same cost/profile rule `decideLaunch`'s own local model
 * pick has always applied to choose ONE model out of a tier's own
 * candidates. Exported so #608's
 * `selectModelWinner` can apply the identical, already-reviewed rule as its
 * OWN final tiebreak (when even the Choice ties exactly) rather than
 * re-deriving a second "which one is the safe pick" order that could drift
 * from this one. Never called with an empty array.
 */
export function cheapestOrPriciestCandidate(
  candidates: readonly { id: string; entry: ModelCapabilityEntry }[],
  profile: JevRoutingProfile
): { id: string; entry: ModelCapabilityEntry } {
  const sorted = [...candidates].sort(
    (a, b) => COST_RANK[a.entry.relativeCost] - COST_RANK[b.entry.relativeCost]
  )
  return profile === 'premium' ? sorted[sorted.length - 1]! : sorted[0]!
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

/** `finalizeModel`'s own result — `model` is always the picked candidate's own id once `parseLaunchTuning` accepts the pairing. */
export interface FinalizedModel {
  model: string
  effort?: string
}

/**
 * The shared tail end of "pick a model" (#608): maps the effort rubric
 * score onto `provider`'s own ladder, narrows it to the picked ENTRY's own
 * accepted levels, then validates the whole (model, effort) pairing through
 * the same launch gate every launch goes through (`parseLaunchTuning`) —
 * belt and braces, the same discipline `decideLaunch` has always held for
 * its OWN local model choice. Written once so `decideLaunch`'s local pick
 * and #608's request-2 winner can never silently disagree about what a
 * valid pairing is. `undefined` when `parseLaunchTuning` refuses the
 * pairing — not reachable through either caller's own derivation today
 * (`id` is always a trimmed catalogue id, `effort` always a member of
 * `PROVIDER_EFFORT_LEVELS[provider]` or absent), kept for the day a
 * capability entry's own id or a future ladder change makes it so.
 */
export function finalizeModel(
  provider: DwarfProvider,
  id: string,
  entry: ModelCapabilityEntry,
  effortScore: number
): FinalizedModel | undefined {
  const providerEffort = mapEffortScore(provider, effortScore, PROVIDER_EFFORT_LEVELS)
  const effort =
    providerEffort === undefined
      ? undefined
      : narrowEffort(PROVIDER_EFFORT_LEVELS[provider], entry.effortLevels, providerEffort)
  const tuning = parseLaunchTuning(provider, {
    model: id,
    ...(effort === undefined ? {} : { effort })
  })
  if (tuning === null || tuning.model === undefined) return undefined
  return { model: tuning.model, ...(tuning.effort === undefined ? {} : { effort: tuning.effort }) }
}

/** One #608 request-2 candidate, as `selectModelWinner` reads it — `key` is the index string it was sent under (`'0'`, `'1'`, …), matching `fits`/`choice.probabilities`' own keys. */
export interface ModelSelectionCandidate {
  key: string
  id: string
  entry: ModelCapabilityEntry
}

/** `selectModelWinner`'s own result — `choiceProbability` is present only when the tie band made the Choice decide (or fail to, falling to `cheapestOrPriciestCandidate`). */
export interface ModelSelection {
  candidate: ModelSelectionCandidate
  /** The winning candidate's own Noul "does it fit" probability. */
  probability: number
  choiceProbability?: number
}

/**
 * #608's own selection rule, over one request-2 answer:
 *
 * 1. The candidate with the highest Noul `fits` probability wins outright,
 *    UNLESS one or more other candidates land within `MODEL_TIE_BAND` of it
 *    — indistinguishable from run-to-run noise (see that constant's own
 *    comment), not a real signal to act on alone.
 * 2. Among a tied group, the Choice's own `probabilities` (never just its
 *    single reported `choice`, which need not even be one of the tied
 *    candidates) decide: the tied candidate with the highest Choice share
 *    wins.
 * 3. If the Choice ALSO ties exactly among them, `cheapestOrPriciestCandidate`
 *    — the identical cost/profile order `decideLaunch`'s own local model
 *    pick already applies — decides, deterministically rather than
 *    arbitrarily (e.g. array order).
 *
 * `undefined` only for an empty candidate list — `routeLaunch.ts` never
 * calls this with fewer than two (see `buildJevModelRouteRequest`'s own
 * comment).
 */
export function selectModelWinner(
  candidates: readonly ModelSelectionCandidate[],
  fits: Readonly<Record<string, number>>,
  choice: { choice: string; probabilities: Readonly<Record<string, number>> },
  profile: JevRoutingProfile
): ModelSelection | undefined {
  if (candidates.length === 0) return undefined

  const probabilityOf = (candidate: ModelSelectionCandidate): number => fits[candidate.key] ?? 0
  const maxProbability = Math.max(...candidates.map(probabilityOf))
  const tied = candidates.filter(
    (candidate) => maxProbability - probabilityOf(candidate) <= MODEL_TIE_BAND
  )
  // Defense in depth (#608 verifier fix): a malformed `fits` value (NaN —
  // `typesafeJevRouter.ts`'s own `isValidProbability` keeps this out of a
  // real wire answer, but this is a pure function any caller can reach
  // directly) makes every `<=` comparison above false, emptying `tied`
  // entirely. `cheapestOrPriciestCandidate` must never be called with an
  // empty array — undefined here is the same honest "cannot pick" this
  // function already reports for an empty CANDIDATE list.
  if (tied.length === 0) return undefined
  if (tied.length === 1) {
    return { candidate: tied[0]!, probability: probabilityOf(tied[0]!) }
  }

  const choiceShareOf = (candidate: ModelSelectionCandidate): number =>
    choice.probabilities[candidate.key] ?? 0
  const maxChoiceShare = Math.max(...tied.map(choiceShareOf))
  const choiceTied = tied.filter((candidate) => choiceShareOf(candidate) === maxChoiceShare)
  // Same defense, for a malformed Choice `probabilities` value.
  if (choiceTied.length === 0) return undefined
  if (choiceTied.length === 1) {
    const winner = choiceTied[0]!
    return {
      candidate: winner,
      probability: probabilityOf(winner),
      choiceProbability: maxChoiceShare
    }
  }

  const picked = cheapestOrPriciestCandidate(
    choiceTied.map((candidate) => ({ id: candidate.id, entry: candidate.entry })),
    profile
  )
  const winner = choiceTied.find((candidate) => candidate.id === picked.id)!
  return {
    candidate: winner,
    probability: probabilityOf(winner),
    choiceProbability: maxChoiceShare
  }
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
    // the local model pick regardless of profile, and capping it too would
    // be a rule with no observable effect today, dressed up as a decision.
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

  // --- concrete model: candidatesAtTier's own step-down walk, once — both
  // the local default choice AND #608's own modelCandidates (below) read
  // off this SAME call, so they can never disagree about which step's
  // candidates are "the tier's own".
  const liveModelIds = new Set(
    (catalogs.find((catalog) => catalog.provider === provider)?.models ?? []).map(
      (model) => model.value
    )
  )
  const found = candidatesAtTier({
    table: capabilities[provider] ?? {},
    tier,
    needsLargeContext: largeContextValue,
    liveModelIds
  })
  const picked =
    found === undefined ? undefined : cheapestOrPriciestCandidate(found.options, profile)

  // --- effort + the belt-and-braces launch-gate check: `finalizeModel`
  // (this module, below) is the shared tail end #608 also gives the
  // request-2 winner — no model, no effort or tuning check either, the same
  // "absent degrades" rule LaunchTuning already holds to.
  let model: string | undefined
  let effort: string | undefined
  if (picked !== undefined) {
    const finalized = finalizeModel(provider, picked.id, picked.entry, answers.effort.score)
    if (finalized === undefined) {
      // Belt and braces, the same discipline the old routeLaunch.ts already
      // held for a raw Jev answer: a derived model/effort pairing this app's
      // own launch gate would refuse is never carried out. Not reachable
      // through this function's own derivation today — see finalizeModel's
      // own comment for why — kept for the day a capability entry's own id
      // or a future ladder change makes it so.
      return { kind: 'fallback', reason: 'invalid-response' }
    }
    model = finalized.model
    effort = finalized.effort
  }

  return {
    kind: 'decision',
    provider,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    // The function-calling cookbook's own rule for a multi-part answer,
    // amended by #608: the MIN of the applied parts' confidences, but ONLY
    // over the parts actually `applied: 'answered'` — a part that fell back
    // to a safe default was never really confident either way, so its raw
    // number must not drag this one down (or up). `undefined` when NEITHER
    // part was answered, rather than a misleading number.
    confidence: minOfAnswered(
      providerOverridden ? undefined : answers.provider.confidence,
      tierOverridden ? undefined : answers.tier.confidence
    ),
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
    },
    modelCandidates: found === undefined ? { tier, options: [] } : found
  }
}
