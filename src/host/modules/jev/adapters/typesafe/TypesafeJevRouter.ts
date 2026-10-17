// The `JevRouter` adapter over TypeSafe (16 §4.9, §6; ADR-017 item 3): the one `@typesafe-ai/sdk`
// import of the codebase (R11). Replaces the found tree's `src/main/jev/typesafeJevRouter.ts`, which
// read the key itself, timed attempts on the SDK's own timer, retried, and read HTTP 403 as an
// invalid response; its question building and answer checks are transplanted here.
//
// - The key arrives per call (16 §6.1) and goes only into the SDK client of that call, which sends it
//   as the bearer: never logged, never in an error, argv or env (ADR-017 item 3). A blank key sends
//   nothing and answers `no-key` (16 §6.6).
// - Every address and setting is explicit, so no `TYPESAFE_*` environment variable can redirect the
//   traffic or raise the SDK's log level (ADR-008 item 4); the SDK's logger is silent.
// - One attempt, no retry (`maxRetries: 0`), bounded by JEV_ATTEMPT_TIMEOUT_MS on the injected
//   Scheduler and by the caller's AbortSignal (16 §6.5). The call is also raced against that abort,
//   so a transport that ignores the signal cannot hold the caller.
// - It never throws (16 §6.3): every failure is a `JevFallbackReason`, logged as `jev.fallback` with
//   the reason only (19 §9.3).
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  choice,
  noul,
  score,
  type ChoiceCriteria,
  type EntryType,
  type Fetch,
  type Logger,
  type NoulQuestion,
  type Questions
} from '@typesafe-ai/sdk'
import type { JevFallbackReason } from '../../../../kernel/domain/sharedContracts'
import type { DiagnosticsLog } from '../../../../kernel/ports/diagnosticsLog'
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import type { SecretValue } from '../../../../kernel/ports/secretReader'
import {
  EFFORT_QUESTION_INSTRUCTIONS,
  EFFORT_RUBRIC,
  IS_TRIVIAL_CRITERIA,
  IS_TRIVIAL_INSTRUCTIONS,
  MODEL_TIER_CRITERIA,
  MODEL_TIER_QUESTION_INSTRUCTIONS,
  NEEDS_LARGE_CONTEXT_CRITERIA,
  NEEDS_LARGE_CONTEXT_INSTRUCTIONS,
  PROVIDER_QUESTION_INSTRUCTIONS,
  TIER_CHOICE_KEYS,
  modelChoiceInstructions,
  modelFitInstructions
} from '../../domain/routeRequest'
import {
  JEV_ATTEMPT_TIMEOUT_MS,
  type JevModelRequest,
  type JevModelResponse,
  type JevRouteRequest,
  type JevRouteResponse,
  type JevRouter
} from '../../ports/jevRouter'

/** TypeSafe's own API root (docs.typesafe.ai); always passed, never read from the environment. */
export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai'

/** The Jev model every request names. */
const JEV_MODEL = 'jev-latest'

export interface TypesafeJevRouterOptions {
  /** Arms the per-attempt timeout (16 §6.5). */
  scheduler: Scheduler
  /** Where `jev.fallback` goes (19 §9.3). */
  log: DiagnosticsLog
  /** The SDK's transport (`TypeSafeClientConfig.fetch`); the global fetch by default. */
  fetch?: Fetch
  /** TypeSafe's API root; `TYPESAFE_BASE_URL` by default. Only an OS test points it elsewhere. */
  baseURL?: string
}

/**
 * Discards every SDK log call: the SDK's `debug` level logs request bodies unredacted (its own
 * `logLevel` doc), and a body carries the person's prompt.
 */
const SILENT_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** One answer, as the wire gives it: never trusted further than these checks. */
type WireAnswer = Record<string, unknown> | undefined

/**
 * The SDK's JSON-value shapes carry an index signature that this app's named question shapes lack;
 * the values are plain JSON either way, so only the type is widened, never the object.
 */
const asEntry = (value: unknown): EntryType => value as EntryType
const asChoiceCriteria = (value: unknown): ChoiceCriteria => value as ChoiceCriteria
const asNoulCriteria = (value: unknown): NoulQuestion['criteria'] =>
  value as NoulQuestion['criteria']

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** Thrown inside the adapter only, when an answer cannot be acted on; never leaves it. */
class InvalidAnswer extends Error {}

function noulProbability(answer: WireAnswer): number {
  if (answer?.type !== 'noul' || !isProbability(answer.noul)) throw new InvalidAnswer()
  return answer.noul
}

function choiceAmong(answer: WireAnswer, labels: readonly string[]): string {
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string') throw new InvalidAnswer()
  if (!labels.includes(answer.choice)) throw new InvalidAnswer()
  return answer.choice
}

function choiceConfidence(answer: WireAnswer, labels: readonly string[]) {
  const picked = choiceAmong(answer, labels)
  if (!isProbability(answer?.confidence)) throw new InvalidAnswer()
  return { choice: picked, confidence: answer.confidence }
}

/**
 * Every failure the SDK documents, as the reason a caller can act on (16 §6.3). `APITimeoutError`
 * extends `APIConnectionError`, so it is tested first; HTTP statuses are read by number so 403 is
 * `unauthorized` like 401.
 */
function reasonFor(error: unknown): JevFallbackReason {
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403) return 'unauthorized'
    if (error.status === 429) return 'rate-limited'
    if (error.status >= 500) return 'unreachable'
    return 'invalid-response'
  }
  if (error instanceof APIUserAbortError || error instanceof APITimeoutError) return 'timeout'
  if (error instanceof APIConnectionError) return 'unreachable'
  // An unparsable body, an answer the checks above refused, or the SDK refusing our own request
  // shape: nothing this request can be acted on.
  return 'invalid-response'
}

/** How one attempt ended before its answer was read. */
type Settled = { kind: 'result'; result: unknown } | { kind: 'failed'; reason: JevFallbackReason }

export class TypesafeJevRouter implements JevRouter {
  constructor(private readonly options: TypesafeJevRouterOptions) {}

  route(
    req: JevRouteRequest,
    key: SecretValue,
    opts?: { signal?: AbortSignal }
  ): Promise<JevRouteResponse> {
    const providerLabels = Object.keys(req.providerCriteria)
    const questions: Questions = {
      is_trivial: noul(asEntry(IS_TRIVIAL_INSTRUCTIONS), asNoulCriteria(IS_TRIVIAL_CRITERIA)),
      needs_large_context: noul(
        asEntry(NEEDS_LARGE_CONTEXT_INSTRUCTIONS),
        asNoulCriteria(NEEDS_LARGE_CONTEXT_CRITERIA)
      ),
      provider: choice(
        asEntry(PROVIDER_QUESTION_INSTRUCTIONS),
        asChoiceCriteria(req.providerCriteria)
      ),
      model_tier: choice(
        asEntry(MODEL_TIER_QUESTION_INSTRUCTIONS),
        asChoiceCriteria(MODEL_TIER_CRITERIA)
      ),
      effort: score(EFFORT_QUESTION_INSTRUCTIONS, EFFORT_RUBRIC)
    }
    return this.ask(req, key, questions, opts?.signal, (answers, usage) => {
      const effort = answers.effort
      if (effort?.type !== 'score' || !isFiniteNumber(effort.score)) throw new InvalidAnswer()
      return {
        kind: 'answers',
        provider: choiceConfidence(answers.provider, providerLabels),
        tier: choiceConfidence(answers.model_tier, TIER_CHOICE_KEYS),
        trivial: { probability: noulProbability(answers.is_trivial) },
        largeContext: { probability: noulProbability(answers.needs_large_context) },
        effort: { score: effort.score },
        usage
      }
    })
  }

  routeModel(
    req: JevModelRequest,
    key: SecretValue,
    opts?: { signal?: AbortSignal }
  ): Promise<JevModelResponse> {
    const indices = Object.keys(req.candidates)
    const questions: Questions = {
      which: choice(asEntry(modelChoiceInstructions(req.tier)), asChoiceCriteria(req.candidates))
    }
    for (const index of indices) {
      questions[`fits::${index}`] = noul(
        asEntry(modelFitInstructions(req.tier, req.candidates[index]!))
      )
    }
    return this.ask(req, key, questions, opts?.signal, (answers, usage) => {
      const which = answers.which
      const picked = choiceAmong(which, indices)
      // Every reported share, not only the winner's: the tie-break reads the others too.
      const probabilities = which?.probabilities
      if (typeof probabilities !== 'object' || probabilities === null) throw new InvalidAnswer()
      const shares = probabilities as Record<string, unknown>
      if (!Object.values(shares).every(isProbability)) throw new InvalidAnswer()
      const fits: Record<string, number> = {}
      for (const index of indices) fits[index] = noulProbability(answers[`fits::${index}`])
      return {
        kind: 'answers',
        fits,
        choice: { choice: picked, probabilities: shares as Record<string, number> },
        usage
      }
    })
  }

  /** One attempt: the SDK call, bounded and abortable, read into an answer or a fallback. */
  private async ask<A>(
    req: { prompt: string; routingProfile: string },
    key: SecretValue,
    questions: Questions,
    signal: AbortSignal | undefined,
    read: (answers: Record<string, WireAnswer>, usage: { inputTokens: number }) => A
  ): Promise<A | { kind: 'fallback'; reason: JevFallbackReason }> {
    if (key.trim() === '') return this.fallback('no-key', 'degraded')
    // Dismissed or superseded before it was asked: nothing is sent (INV-87).
    if (signal?.aborted === true) return this.fallback('timeout', 'skipped')

    const controller = new AbortController()
    let timedOut = false
    const timer = this.options.scheduler.after(JEV_ATTEMPT_TIMEOUT_MS, () => {
      timedOut = true
      controller.abort()
    })
    const onCallerAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onCallerAbort, { once: true })

    try {
      const settled = await Promise.race([
        this.send(req, key, questions, controller.signal),
        new Promise<Settled>((resolve) =>
          controller.signal.addEventListener(
            'abort',
            () => resolve({ kind: 'failed', reason: 'timeout' }),
            { once: true }
          )
        )
      ])
      if (controller.signal.aborted) {
        return this.fallback('timeout', timedOut ? 'degraded' : 'skipped')
      }
      if (settled.kind === 'failed') return this.fallback(settled.reason, 'degraded')
      return this.read(settled.result, read)
    } finally {
      timer.cancel()
      signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  private async send(
    req: { prompt: string; routingProfile: string },
    key: SecretValue,
    questions: Questions,
    signal: AbortSignal
  ): Promise<Settled> {
    try {
      const client = new TypeSafeClient({
        apiKey: key,
        baseURL: this.options.baseURL ?? TYPESAFE_BASE_URL,
        defaultModel: JEV_MODEL,
        logLevel: 'off',
        logger: SILENT_LOGGER,
        retry: { maxRetries: 0 },
        // The Scheduler bounds the attempt; the SDK's own timer only backs it up.
        timeout: JEV_ATTEMPT_TIMEOUT_MS,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch })
      })
      const result = await client.systemOne(
        {
          state: { prompt: req.prompt, routing_profile: req.routingProfile },
          model: JEV_MODEL,
          questions
        },
        { signal }
      )
      return { kind: 'result', result }
    } catch (error) {
      return { kind: 'failed', reason: reasonFor(error) }
    }
  }

  private read<A>(
    result: unknown,
    read: (answers: Record<string, WireAnswer>, usage: { inputTokens: number }) => A
  ): A | { kind: 'fallback'; reason: JevFallbackReason } {
    try {
      const body = result as { answers?: unknown; usage?: { input_tokens?: unknown } } | null
      const answers = body?.answers
      const inputTokens = body?.usage?.input_tokens
      if (typeof answers !== 'object' || answers === null || !isFiniteNumber(inputTokens)) {
        throw new InvalidAnswer()
      }
      return read(answers as Record<string, WireAnswer>, { inputTokens })
    } catch {
      return this.fallback('invalid-response', 'degraded')
    }
  }

  /** The fallback, logged with its reason and nothing else (19 §9.3; NFR-SEC-12). */
  private fallback(
    reason: JevFallbackReason,
    outcome: 'degraded' | 'skipped'
  ): { kind: 'fallback'; reason: JevFallbackReason } {
    this.options.log.record({
      level: 'warn',
      event: 'jev.fallback',
      subsystem: 'jev',
      outcome,
      causeClass: reason
    })
    return { kind: 'fallback', reason }
  }
}
