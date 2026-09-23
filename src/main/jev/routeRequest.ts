import { PRODUCT_NAME } from '../domain/launchProviders'
import type { PROVIDER_EFFORT_LEVELS } from '../domain/launchTuning'
import type {
  AgentProviderOption,
  DwarfProvider,
  JevRoutingProfile,
  ModelTier
} from '../domain/types'
import type { ModelCapabilityEntry } from './capabilities/modelCapability'
import type {
  JevChoiceCriteria,
  JevModelCandidateCriteria,
  JevModelRouteRequest,
  JevRouteRequest
} from './jevRouterPort'
import type { JevCapabilityTable } from './routeDecision'

/**
 * Turning what the launch already knows — which providers this app can
 * actually start, and the routing profile Settings holds — into ONE System
 * One request of FIVE parallel questions (jev-routing-profiles T3, request
 * v2). Pure: every fact it reads was already asked for elsewhere
 * (listAgentProviders) or is a fixed table this module already imports
 * (MODEL_CAPABILITIES), so this is only shaping.
 *
 * ## Why five questions, and why they never chain
 *
 * The v1 request (#509) asked ONE Choice over every (provider, model) pair —
 * up to a dozen near-identical options, and near-identical option TEXT is a
 * calibrated matcher's known failure mode (System One's own consistency
 * cookbook): confidence flattens across the whole set. Splitting the
 * question along the axes that actually vary — is this trivial, does it need
 * a huge context, which provider's tooling fits, how capable a model, how
 * hard is the work — gives Jev a SMALL, clearly contrastive option set per
 * question instead of one long one. All five stay in ONE request (TypeSafe's
 * own systemOne call answers every question against the same `state` in
 * parallel): a second stage that re-asked based on the first answer would
 * double the latency budget for a call already on this app's own critical
 * launch path, for a gain no evidence here shows is needed under twenty
 * options.
 *
 * `model_tier` and `provider` are independent by design, unlike v1's single
 * merged choice: `routeDecision.ts`'s `decideLaunch` is what turns
 * (provider, tier, profile, needs_large_context) into one concrete model
 * through the capability table, so a disagreement between the two answers
 * is resolved there, once, rather than by making the question no CLI could
 * ever answer contradiction-free at the wire.
 */

/**
 * One Choice or Noul question's own instructions, in TypeSafe's OWN
 * documented vocabulary — `question` is the ask itself, `focus` narrows what
 * Jev should weigh, `inspect` names a `state` field Jev should read to
 * condition its answer. Snake-case-free by design (these three keys are
 * TypeSafe's own spelling too), kept as an object rather than a single
 * string so `focus`/`inspect` can be added without changing every question's
 * shape at once.
 */
export interface JevQuestionInstructions {
  question: string
  focus?: string
  inspect?: string
}

/** One side of a Noul's own two-sided description. */
export interface JevNoulSideCriteria {
  what: string
  examples: readonly [string, string]
}

/**
 * The fixed task-difficulty rubric asked in every route request, independent
 * of which provider ends up chosen. `mapEffortScore` is what turns the score
 * this rubric returns into a level on the CHOSEN provider's own ladder —
 * kept separate because the rubric is asked once per launch and the mapping
 * needs to know the answer to the other questions first (`routeDecision.ts`).
 */
export const EFFORT_RUBRIC = [
  'A trivial lookup — a one-line factual question with no code change.',
  'A small, contained edit — one file, a well-understood change.',
  'A multi-file change — coordinating an edit across several files or modules.',
  'Architectural or migration-scale work — a design decision, or a change that touches the shape of the system.'
] as const

const EFFORT_RUBRIC_MAX_SCORE = EFFORT_RUBRIC.length - 1

export const EFFORT_QUESTION_INSTRUCTIONS =
  'How difficult is the work described in state? Score it against the rubric — a low score is ' +
  'quick and mechanical, a high score is architectural or spans many files.'

/**
 * Where a rubric score (0..3, possibly fractional — System One's own score
 * answers may fall between integer rubric levels) lands on ONE provider's
 * own effort ladder, proportionally rather than by a fixed offset. A fixed
 * offset would run off the short end of the smallest ladder: the ladders are
 * different lengths (Claude 5, Codex 6, Antigravity 3 — PROVIDER_EFFORT_LEVELS
 * in launchTuning.ts), so "add 2" means something different for each one.
 *
 * `undefined` for an empty ladder, on the same terms LaunchTuning already
 * reads absence as: the CLI keeps its own default. `routeDecision.ts`
 * narrows this further to the CHOSEN MODEL's own accepted levels, which can
 * be a strict subset of the provider's full ladder (Codex's `ultra`).
 */
export function mapEffortScore(
  provider: DwarfProvider,
  score: number,
  effortLevels: typeof PROVIDER_EFFORT_LEVELS
): string | undefined {
  const ladder = effortLevels[provider]
  if (ladder.length === 0) return undefined
  const clamped = Math.min(Math.max(score, 0), EFFORT_RUBRIC_MAX_SCORE)
  const index = Math.round((clamped / EFFORT_RUBRIC_MAX_SCORE) * (ladder.length - 1))
  return ladder[index]
}

export const IS_TRIVIAL_INSTRUCTIONS: JevQuestionInstructions = {
  question:
    'Is this prompt trivial — small talk or a one-line factual question that asks for no code ' +
    'change — rather than a real request to write, read, debug, explain or change code?'
}

export const IS_TRIVIAL_CRITERIA: { true: JevNoulSideCriteria; false: JevNoulSideCriteria } = {
  true: {
    what: 'Small talk, a greeting, thanks, or a one-line factual question that asks for no code change.',
    examples: ['Thanks, that fixed it!', 'What does HTTP 404 mean?']
  },
  false: {
    what: 'Any request to write, read, debug, explain or change code, however small.',
    examples: ['Fix the typo on line 12.', 'What does this function do?']
  }
}

export const NEEDS_LARGE_CONTEXT_INSTRUCTIONS: JevQuestionInstructions = {
  question:
    'Does this prompt need a very large amount of context — many files or modules, or a large ' +
    'pasted corpus — rather than being scoped to one file or function?'
}

export const NEEDS_LARGE_CONTEXT_CRITERIA: {
  true: JevNoulSideCriteria
  false: JevNoulSideCriteria
} = {
  true: {
    what: 'Spans many files or modules, or includes a large pasted corpus of text or code to reason over.',
    examples: [
      'Review this migration end to end across the whole repository.',
      'Here is our entire changelog pasted below — summarize the breaking changes.'
    ]
  },
  false: {
    what: 'Scoped to one file or one function, with nothing extra to hold in mind.',
    examples: ['Fix the bug in this one function.', 'Add a docstring to this file.']
  }
}

export const PROVIDER_QUESTION_INSTRUCTIONS: JevQuestionInstructions = {
  question:
    'Which agent CLI is the best tooling fit for this prompt, from providers this app can ' +
    'actually launch right now?',
  focus: 'Judge tooling and ecosystem fit only, not cost.',
  inspect: 'prompt'
}

/**
 * Held versus detached is a real TOOLING fact this app already draws on
 * (`launchProviders.ts`'s own module comment: Claude Code can be HELD, an
 * Agent SDK stream this panel keeps live; Codex and Antigravity can only be
 * DETACHED, started and let go of). Used here because
 * `PROVIDER_QUESTION_INSTRUCTIONS.focus` asks Jev to judge tooling fit, not
 * cost, and this is the one tooling difference this app can state as a
 * verified fact rather than invent. A product default (the exact wording),
 * tunable from the JEV_DEBUG trace like the floors in routeDecision.ts.
 */
const HELD_TOOLING_NOTE: Readonly<Record<DwarfProvider, string>> = {
  claude:
    'Runs as a held session this panel keeps live, so its output streams back to you as it works.',
  codex:
    'Runs detached — started and then let go of, better suited to a task you check back on than one you watch live.',
  antigravity:
    'Runs detached — started and then let go of, better suited to a task you check back on than one you watch live.',
  // #547 (was: '', "Never launchable — never reached" — #537 joined OpenCode
  // to LAUNCHABLE_PROVIDERS, so this note is now read on every request that
  // offers it). Detached through `opencode run` (#534) — the same register as
  // Codex's and Antigravity's own notes — and the panel can continue the
  // SAME session afterward with `opencode run --session <id>` (#546,
  // opencodeContinue.ts's `buildOpenCodeContinueArgs`), a capability neither
  // of those two has.
  opencode:
    'Runs detached — started and then let go of, better suited to a task you check back on than one you watch live; the panel can continue the same session afterward.'
}

/** Two examples per provider that lean on the held/detached difference above — the same product-default caveat. */
const PROVIDER_EXAMPLES: Readonly<Record<DwarfProvider, readonly [string, string]>> = {
  claude: [
    'Keep working on this while I watch and steer as you go.',
    'Investigate this bug and talk me through what you find.'
  ],
  codex: [
    'Take care of this in the background — I will check back later.',
    'Run this migration and report back once it is done.'
  ],
  antigravity: [
    'Take care of this in the background — I will check back later.',
    'Run this migration and report back once it is done.'
  ],
  // #547 (was: ['', ''], "Never launchable — never reached"). Two examples in
  // the same detached register Codex's own pair already uses above — #534
  // put OpenCode on identical tooling terms to Codex (started, let go of),
  // so the same two prompts fit it for the same reason they fit Codex.
  opencode: [
    'Take care of this in the background — I will check back later.',
    'Run this migration and report back once it is done.'
  ]
}

/** Tiers a routing decision may actually land on — `'special-purpose'` (an image model, an internal reviewer) is never offered here. */
const ROUTING_TIERS: readonly ModelTier[] = ['fast-cheap', 'balanced', 'frontier', 'long-context']

/** "fast-cheap, balanced and frontier models" — an ordinary English list, never an Oxford-comma debate worth a dependency. */
function describeTierList(tiers: readonly ModelTier[]): string {
  if (tiers.length === 0) return 'models'
  if (tiers.length === 1) return `${tiers[0]} models`
  return `${tiers.slice(0, -1).join(', ')} and ${tiers[tiers.length - 1]} models`
}

/**
 * Whether `capabilities[provider]` has at least one entry a launch may
 * actually be offered on (#547) — the same test `providerChoiceCriteria`
 * already filters its own tier list by. A provider with none (OpenCode's
 * derived table when its catalogue could not be read) has nothing this
 * question could truthfully describe, so `buildJevRouteRequest` omits it
 * entirely rather than sending an option built from zero tiers — the same
 * "degrade rather than send something empty" rule a non-launchable provider
 * already gets from `AgentProviderOption.launchable`.
 */
function hasAnyLaunchTarget(entries: Readonly<Record<string, ModelCapabilityEntry>>): boolean {
  return Object.values(entries).some((entry) => entry.launchTarget)
}

/** One provider's own `provider` Choice option, built from PRODUCT_NAME and its capability table's own offered tiers — never from a model name (see this module's own top comment). */
function providerChoiceCriteria(
  provider: DwarfProvider,
  capabilities: JevCapabilityTable
): JevChoiceCriteria {
  const offeredTiers = Array.from(
    new Set(
      Object.values(capabilities[provider])
        .filter(
          (entry) => entry.launchTarget && (ROUTING_TIERS as readonly string[]).includes(entry.tier)
        )
        .map((entry) => entry.tier as ModelTier)
    )
  )
  return {
    what: `${PRODUCT_NAME[provider]} — ${HELD_TOOLING_NOTE[provider]} Offers ${describeTierList(offeredTiers)}.`,
    examples: PROVIDER_EXAMPLES[provider]
  }
}

/** The catch-all `provider` option for "no requirement" — see `routeDecision.ts`'s own no-preference handling. */
const NO_PREFERENCE_PROVIDER_CRITERIA: JevChoiceCriteria = {
  what: 'No requirement for a specific provider or its tooling — any capable provider works.',
  examples: ['Fix this bug.', 'Add this feature.']
}

/** Every key the `model_tier` Choice may answer with — snake_case, TypeSafe's own spelling, and the wire's `'no_preference'` twin to the `provider` question. */
export const TIER_CHOICE_KEYS = [
  'fast_cheap',
  'balanced',
  'frontier',
  'long_context',
  'no_preference'
] as const
export type TierChoiceKey = (typeof TIER_CHOICE_KEYS)[number]

/** Every answerable tier key mapped onto the internal `ModelTier` vocabulary `routeDecision.ts` and the capability table share. */
export const TIER_CHOICE_TO_MODEL_TIER: Readonly<
  Record<Exclude<TierChoiceKey, 'no_preference'>, ModelTier>
> = {
  fast_cheap: 'fast-cheap',
  balanced: 'balanced',
  frontier: 'frontier',
  long_context: 'long-context'
}

export const MODEL_TIER_QUESTION_INSTRUCTIONS: JevQuestionInstructions = {
  question: 'How capable a model does this prompt need?',
  focus:
    "Apply the chosen routing profile's own rule: economy prefers the cheapest tier that can " +
    'still do the job; balanced weighs cost and capability together; premium reaches for the ' +
    'frontier tier when the task needs deep reasoning, architecture-level judgment or tricky ' +
    'multi-file coordination — never for a trivial prompt, whatever the profile.',
  inspect: 'routing_profile'
}

export const MODEL_TIER_CRITERIA: Readonly<Record<TierChoiceKey, JevChoiceCriteria>> = {
  fast_cheap: {
    what: 'A quick, well-understood, low-risk task that needs no real reasoning depth.',
    examples: [
      'Rename this variable across the file.',
      'Add a null check before this property access.'
    ]
  },
  balanced: {
    what: 'An everyday task that needs real reasoning but nothing architectural.',
    examples: [
      'Add a new field to this form and wire it through validation.',
      'Extract this duplicated logic into a shared helper.'
    ]
  },
  frontier: {
    what: 'A hard task needing deep reasoning, architecture-level judgment, or tricky multi-file coordination.',
    not_for: 'Trivial or simple prompts, whatever the routing profile.',
    examples: [
      'Design the data model for a feature this codebase has never had before.',
      'Untangle a deadlock that only reproduces under real production load.'
    ]
  },
  long_context: {
    what: 'A task whose relevant material will not fit an ordinary context window.',
    examples: [
      'Trace where this regression was introduced across the full test history.',
      'Review this migration end to end across the whole monorepo.'
    ]
  },
  no_preference: {
    what: 'No clear signal about how capable a model this needs — let the routing profile decide.',
    examples: [
      'Continue the change already under way in this thread.',
      'Take a look at this and tell me what you think.'
    ]
  }
}

/**
 * TypeSafe's own limits (docs.typesafe.ai, verified 2026-09-20 — issue
 * #509's evidence section): 64k tokens total per systemOne request, and 32k
 * for `state` plus the single longest question. Estimated as ceil(chars/4), a
 * rough rule of thumb for English text — TypeSafe publishes no tokenizer and
 * no chars-per-token figure, so this is an ESTIMATE, never an exact count,
 * and the budget below is read conservatively because of it.
 *
 * Unlike v1, none of the five questions here scale with a model catalogue —
 * four are fixed constants and `provider` scales with the launchable
 * provider count alone (at most a handful) — so `budget-exceeded` is, in
 * practice, unreachable through the fixed questions today. The guard stays
 * for the same reason `parseLaunchTuning` re-validates a decision this app
 * already built: belt and braces, cheap to keep, never trusted away.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4
const MAX_REQUEST_TOKENS = 64_000
const MAX_STATE_AND_LONGEST_QUESTION_TOKENS = 32_000
const TRUNCATION_MARKER = '\n…\n'

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
}

/** Keeps the head and the tail of `text` within `maxChars`, marked in between. */
function truncateHeadTail(text: string, maxChars: number): string {
  const budget = Math.max(0, maxChars)
  if (budget <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, budget)
  const keep = budget - TRUNCATION_MARKER.length
  const headChars = Math.ceil(keep / 2)
  const tailChars = keep - headChars
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : ''
  return text.slice(0, headChars) + TRUNCATION_MARKER + tail
}

export interface BuildJevRouteRequestInput {
  prompt: string
  routingProfile: JevRoutingProfile
  providers: readonly AgentProviderOption[]
  /**
   * The per-install capability table, injected rather than imported (#547) —
   * the same `JevCapabilityTable` shape `decideLaunch` already takes, so the
   * two never disagree about which providers have entries. `routeLaunch.ts`
   * assembles the real one at route time (curated tables plus OpenCode's own
   * live-derived one); tests pass a small synthetic table instead, the same
   * way `routeDecision.test.ts` already does.
   */
  capabilities: JevCapabilityTable
}

export type BuildJevRouteRequestResult =
  | { kind: 'request'; request: JevRouteRequest }
  | { kind: 'skip'; reason: 'no-launchable-provider' | 'budget-exceeded' }

/**
 * Builds one System One request, or says why none can be built. Never
 * reaches for LAUNCHABLE_PROVIDERS itself — `providers` already carries each
 * option's own `launchable` verdict (agentProviderList), and reading it
 * straight off the input is what keeps this module decoupled from that
 * table rather than duplicating its rule.
 *
 * A launchable provider whose `capabilities` entry has ZERO `launchTarget:
 * true` models is OMITTED from the `provider` question too (#547) — the
 * same "degrade rather than offer something empty" rule `launchable` above
 * already applies, extended to cover a provider that CAN be started but has
 * nothing this table could truthfully describe (OpenCode when its own live
 * catalogue could not be read). This is the only place that check happens:
 * a provider passing it always has at least one tier `providerChoiceCriteria`
 * can name.
 */
export function buildJevRouteRequest(input: BuildJevRouteRequestInput): BuildJevRouteRequestResult {
  const launchable = input.providers.filter(
    (provider) => provider.launchable && hasAnyLaunchTarget(input.capabilities[provider.provider])
  )
  if (launchable.length === 0) return { kind: 'skip', reason: 'no-launchable-provider' }

  const providerCriteria: Record<string, JevChoiceCriteria> = {}
  for (const option of launchable) {
    providerCriteria[option.provider] = providerChoiceCriteria(option.provider, input.capabilities)
  }
  providerCriteria.no_preference = NO_PREFERENCE_PROVIDER_CRITERIA

  const questionTokenCosts = {
    trivial: estimateTokens(
      JSON.stringify(IS_TRIVIAL_INSTRUCTIONS) + JSON.stringify(IS_TRIVIAL_CRITERIA)
    ),
    largeContext: estimateTokens(
      JSON.stringify(NEEDS_LARGE_CONTEXT_INSTRUCTIONS) +
        JSON.stringify(NEEDS_LARGE_CONTEXT_CRITERIA)
    ),
    provider: estimateTokens(
      JSON.stringify(PROVIDER_QUESTION_INSTRUCTIONS) + JSON.stringify(providerCriteria)
    ),
    tier: estimateTokens(
      JSON.stringify(MODEL_TIER_QUESTION_INSTRUCTIONS) + JSON.stringify(MODEL_TIER_CRITERIA)
    ),
    effort: estimateTokens(EFFORT_QUESTION_INSTRUCTIONS + EFFORT_RUBRIC.join(''))
  }
  const longestQuestionTokens = Math.max(...Object.values(questionTokenCosts))
  const allQuestionsTokens = Object.values(questionTokenCosts).reduce((sum, cost) => sum + cost, 0)

  if (
    longestQuestionTokens >= MAX_STATE_AND_LONGEST_QUESTION_TOKENS ||
    allQuestionsTokens >= MAX_REQUEST_TOKENS
  ) {
    return { kind: 'skip', reason: 'budget-exceeded' }
  }

  const stateBudgetTokens = MAX_STATE_AND_LONGEST_QUESTION_TOKENS - longestQuestionTokens
  const truncated = estimateTokens(input.prompt) > stateBudgetTokens
  const prompt = truncated
    ? truncateHeadTail(input.prompt, stateBudgetTokens * CHARS_PER_TOKEN_ESTIMATE)
    : input.prompt

  return {
    kind: 'request',
    request: { prompt, routingProfile: input.routingProfile, truncated, providerCriteria }
  }
}

/* --- #608: the second request, over the tier's own candidate models ------- */

/**
 * One candidate's own capability facts, in `JevModelCandidateCriteria`'s own
 * shape (jevRouterPort.ts) — `what`/`notFor`/`examples` straight off the
 * entry, plus `tier`/`relativeCost`/`contextWindowTokens` so two same-tier
 * candidates can still be told apart on cost and context alone when their
 * prose is close. Never the model's own id, name, alias or family — see this
 * module's own top comment and the jev-capabilities skill's evidence rule.
 * The one function both `buildJevModelRouteRequest` below and
 * `typesafeJevRouter.ts`'s adapter call, so the Choice criteria and every
 * Noul's own embedded facts are built from the identical values.
 */
export function candidateCapabilityFacts(entry: ModelCapabilityEntry): JevModelCandidateCriteria {
  return {
    what: entry.what,
    not_for: entry.notFor,
    examples: entry.examples,
    tier: entry.tier,
    relativeCost: entry.relativeCost,
    ...(entry.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: entry.contextWindowTokens })
  }
}

/**
 * The `which` Choice question's own instructions (#608) — parameterised by
 * `tier`, unlike request 1's fixed questions, because THIS tier is a fact
 * about the launch just resolved, not a fixed rubric. Mirrors the skill-
 * suggestion cookbook's own `RERANK_INSTRUCTIONS`: exactly one candidate is
 * the right one, read what each actually offers rather than guessing from a
 * label — there is no label here to guess from anyway.
 */
export function modelChoiceInstructions(tier: ModelTier): JevQuestionInstructions {
  return {
    question:
      `Exactly one of these models is the best fit for the prompt in state, given the task ` +
      `needs a ${tier} model. Which one?`
  }
}

/**
 * One `fits::<index>` Noul question's own instructions (#608) — the
 * candidate's own capability facts ride INSIDE the structured instructions
 * object (never in `criteria`, which a Noul only ever gives two fixed
 * yes/no sides — primitives/noul.md), the same "structure when the question
 * needs data alongside it" shape the SDE cascade cookbook and this file's
 * own `EFFORT_QUESTION_INSTRUCTIONS` sibling questions already use.
 */
export function modelFitInstructions(
  tier: ModelTier,
  candidate: JevModelCandidateCriteria
): { question: string; candidate: JevModelCandidateCriteria } {
  return {
    question: `Given the task needs a ${tier} model, does this specific model fit the prompt in state?`,
    candidate
  }
}

export interface BuildJevModelRouteRequestInput {
  prompt: string
  routingProfile: JevRoutingProfile
  /** The tier the task needs — read into the fit question, and carried on the request for the adapter to phrase the Choice question with too. */
  tier: ModelTier
  /**
   * Two or more candidates. `routeLaunch.ts` never calls this with fewer:
   * zero candidates means nothing to ask about, and exactly one means no
   * second request at all (`applied: 'only-candidate'`) — both decided
   * before this function is ever reached.
   */
  candidates: ReadonlyArray<{ id: string; entry: ModelCapabilityEntry }>
}

export type BuildJevModelRouteRequestResult =
  { kind: 'request'; request: JevModelRouteRequest } | { kind: 'skip'; reason: 'budget-exceeded' }

/**
 * Builds #608's second System One request, or says why it could not fit —
 * the same token-budgeting discipline `buildJevRouteRequest` already holds
 * to (TypeSafe's own 64k-total / 32k-state-plus-longest-question limits,
 * estimated the same conservative ceil(chars/4) way), reused rather than
 * reimplemented. Unlike request 1's fixed five questions, THIS request's
 * size scales with the candidate count, so `budget-exceeded` is a real,
 * reachable outcome here — a large OpenCode tier with many differentiated
 * candidates is exactly the case #608 T1 exists for.
 *
 * Candidates are keyed by INDEX (`'0'`, `'1'`, …) in both the returned
 * request's own `candidates` and the `fits::<index>` Noul questions the
 * adapter builds from it — never by the candidate's own model id, so a
 * model's identity never rides the wire to Jev (jev-capabilities skill's
 * evidence rule).
 */
export function buildJevModelRouteRequest(
  input: BuildJevModelRouteRequestInput
): BuildJevModelRouteRequestResult {
  const candidateCriteria: Record<string, JevModelCandidateCriteria> = {}
  input.candidates.forEach((candidate, index) => {
    candidateCriteria[String(index)] = candidateCapabilityFacts(candidate.entry)
  })

  const questionTokenCosts: Record<string, number> = {
    which: estimateTokens(
      JSON.stringify(modelChoiceInstructions(input.tier)) + JSON.stringify(candidateCriteria)
    )
  }
  for (const [key, criteria] of Object.entries(candidateCriteria)) {
    questionTokenCosts[`fits::${key}`] = estimateTokens(
      JSON.stringify(modelFitInstructions(input.tier, criteria))
    )
  }
  const longestQuestionTokens = Math.max(...Object.values(questionTokenCosts))
  const allQuestionsTokens = Object.values(questionTokenCosts).reduce((sum, cost) => sum + cost, 0)

  if (
    longestQuestionTokens >= MAX_STATE_AND_LONGEST_QUESTION_TOKENS ||
    allQuestionsTokens >= MAX_REQUEST_TOKENS
  ) {
    return { kind: 'skip', reason: 'budget-exceeded' }
  }

  const stateBudgetTokens = MAX_STATE_AND_LONGEST_QUESTION_TOKENS - longestQuestionTokens
  const truncated = estimateTokens(input.prompt) > stateBudgetTokens
  const prompt = truncated
    ? truncateHeadTail(input.prompt, stateBudgetTokens * CHARS_PER_TOKEN_ESTIMATE)
    : input.prompt

  return {
    kind: 'request',
    request: {
      prompt,
      routingProfile: input.routingProfile,
      truncated,
      tier: input.tier,
      candidates: candidateCriteria
    }
  }
}

/* --- end of the #608 block ------------------------------------------------- */
