import { PRODUCT_NAME } from '../domain/launchProviders'
import type { PROVIDER_EFFORT_LEVELS } from '../domain/launchTuning'
import type {
  AgentModelCatalog,
  AgentProviderOption,
  DwarfProvider,
  ModelOption
} from '../domain/types'
import type { JevModelChoice, JevRouteRequest } from './jevRouterPort'

/**
 * Turning what the launch already knows — which providers this app can
 * actually start, and each one's own model catalogue — into ONE System One
 * request (issue #509). Pure: every fact it reads was already asked for
 * elsewhere (listAgentProviders, listAgentModels), so this is only shaping,
 * exactly the reason agentModelCatalog.ts is pure and its IO lives outside it.
 *
 * ## Why one request asks two questions, and never a third for `provider`
 *
 * A separate `provider` question would be a SECOND independent answer that
 * could disagree with what the `model` question already implies — Jev could
 * name Claude for `provider` and a Codex model for `model` — and resolving
 * that disagreement would need a rule nobody chose. Naming the provider
 * INSIDE the model key instead makes the two answers structurally unable to
 * disagree: whichever key `model` returns, the provider is read straight off
 * it, so it is by construction a provider this app can launch and the model
 * is by construction in that provider's own catalogue.
 */

/**
 * The fixed task-difficulty rubric asked in every route request, independent
 * of which provider ends up chosen. `mapEffortScore` is what turns the score
 * this rubric returns into a level on the CHOSEN provider's own ladder —
 * kept separate because the rubric is asked once per launch and the mapping
 * needs to know the answer to the other question first.
 */
export const EFFORT_RUBRIC = [
  'A trivial lookup — a one-line factual question with no code change.',
  'A small, contained edit — one file, a well-understood change.',
  'A multi-file change — coordinating an edit across several files or modules.',
  'Architectural or migration-scale work — a design decision, or a change that touches the shape of the system.'
] as const

const EFFORT_RUBRIC_MAX_SCORE = EFFORT_RUBRIC.length - 1

export const MODEL_QUESTION_INSTRUCTIONS =
  'Which agent CLI and model should run the prompt in state? Choose the option whose provider ' +
  'and model best fit the work described, from providers this app can actually launch right now.'

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
 * reads absence as: the CLI keeps its own default.
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

/**
 * TypeSafe's own limits (docs.typesafe.ai, verified 2026-09-20 — issue
 * #509's evidence section): 64k tokens total per systemOne request, and 32k
 * for `state` plus the single longest question. Estimated as ceil(chars/4), a
 * rough rule of thumb for English text — TypeSafe publishes no tokenizer and
 * no chars-per-token figure, so this is an ESTIMATE, never an exact count,
 * and the budget below is read conservatively because of it.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4
const MAX_REQUEST_TOKENS = 64_000
const MAX_STATE_AND_LONGEST_QUESTION_TOKENS = 32_000
/** TypeSafe's Choice question takes at most 255 options. */
const MAX_MODEL_CHOICES = 255
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
  providers: readonly AgentProviderOption[]
  catalogs: readonly AgentModelCatalog[]
  effortLevels: typeof PROVIDER_EFFORT_LEVELS
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
 */
export function buildJevRouteRequest(input: BuildJevRouteRequestInput): BuildJevRouteRequestResult {
  const launchable = input.providers.filter((provider) => provider.launchable)
  if (launchable.length === 0) return { kind: 'skip', reason: 'no-launchable-provider' }

  const modelChoices: JevModelChoice[] = []
  for (const providerOption of launchable) {
    const catalog = input.catalogs.find((entry) => entry.provider === providerOption.provider)
    const models = catalog?.models ?? []
    if (models.length === 0) {
      modelChoices.push({
        key: `${providerOption.provider}:`,
        provider: providerOption.provider,
        criteria: modelChoiceCriteria(providerOption.provider, undefined, input.effortLevels)
      })
      continue
    }
    for (const model of models) {
      modelChoices.push({
        key: `${providerOption.provider}:${model.value}`,
        provider: providerOption.provider,
        model: model.value,
        criteria: modelChoiceCriteria(providerOption.provider, model, input.effortLevels)
      })
    }
  }

  // Past TypeSafe's own 255-option cap the choice set cannot be sent at all —
  // exactly the "absurd catalogue" the token budget below also guards
  // against, so it shares that reason rather than a second one nothing
  // downstream would act on differently.
  if (modelChoices.length > MAX_MODEL_CHOICES) return { kind: 'skip', reason: 'budget-exceeded' }

  const modelQuestionTokens = estimateTokens(
    MODEL_QUESTION_INSTRUCTIONS + modelChoices.map((entry) => entry.key + entry.criteria).join('')
  )
  const effortQuestionTokens = estimateTokens(EFFORT_QUESTION_INSTRUCTIONS + EFFORT_RUBRIC.join(''))
  const longestQuestionTokens = Math.max(modelQuestionTokens, effortQuestionTokens)

  if (
    longestQuestionTokens >= MAX_STATE_AND_LONGEST_QUESTION_TOKENS ||
    modelQuestionTokens + effortQuestionTokens >= MAX_REQUEST_TOKENS
  ) {
    return { kind: 'skip', reason: 'budget-exceeded' }
  }

  const stateBudgetTokens = MAX_STATE_AND_LONGEST_QUESTION_TOKENS - longestQuestionTokens
  const truncated = estimateTokens(input.prompt) > stateBudgetTokens
  const state = truncated
    ? truncateHeadTail(input.prompt, stateBudgetTokens * CHARS_PER_TOKEN_ESTIMATE)
    : input.prompt

  return { kind: 'request', request: { state, truncated, modelChoices } }
}

/**
 * The one-line sentence Jev sees for one model choice. Names the provider's
 * own product name (never its CLI binary — see PRODUCT_NAME's own comment)
 * and, when this provider's own effort ladder is empty, says so: the score
 * question is still asked of every launch, but a provider that cannot act on
 * an effort level should not have Jev spend its reasoning on one.
 */
function modelChoiceCriteria(
  provider: DwarfProvider,
  model: ModelOption | undefined,
  effortLevels: typeof PROVIDER_EFFORT_LEVELS
): string {
  const name = PRODUCT_NAME[provider]
  const modelPart =
    model === undefined
      ? 'letting the CLI pick its own default model'
      : `running the "${model.label ?? model.value}" model`
  const effortPart =
    effortLevels[provider].length === 0
      ? ' (this provider takes no effort level, so the score above does nothing for it)'
      : ''
  return `${name}, ${modelPart}${effortPart}.`
}
