import {
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
  TypeSafeClient,
  choice,
  noul,
  score,
  type ChoiceCriteria,
  type EntryType,
  type Logger,
  type NoulQuestion
} from '@typesafe-ai/sdk'
import type {
  JevFallbackReason,
  JevModelRouteOutcome,
  JevModelRouteRequest,
  JevRouteOutcome,
  JevRouteRequest,
  JevRouterPort
} from './jevRouterPort'
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
} from './routeRequest'

/**
 * The SDK adapter for JevRouterPort (issue #509; request v2,
 * jev-routing-profiles T3), over `@typesafe-ai/sdk` 0.6.0. Verified against
 * docs.typesafe.ai and, ultimately, this repo's own
 * `node_modules/.pnpm/@typesafe-ai+sdk@0.6.0/.../dist/index.d.mts` — the
 * type declarations are the ground truth this module was written against.
 *
 * Sends the five fixed questions and returns Jev's RAW answers
 * (`JevRouteAnswers`) — no confidence gate here any more. The v1 adapter
 * refused a whole decision below one overall confidence floor
 * (`JEV_MIN_CONFIDENCE`, removed); request v2 asks per-question floors
 * instead, and resolving a low-confidence PART to a safe default rather than
 * refusing the whole call is `routeDecision.ts`'s job — see its own module
 * comment and `PROVIDER_CONFIDENCE_FLOOR`/`TIER_CONFIDENCE_FLOOR`.
 */

/** The name of the dev-only routing-trace switch (issue #525). */
const JEV_DEBUG_ENV_VAR = 'JEV_DEBUG'

/**
 * Whether this process should trace every Jev routing call to the console.
 *
 * Read straight from the real environment at the composition point, never
 * through `AppConfig` — the omission is the point, exactly as
 * `DWARFAI_SIMULATE`'s switch is kept out of `loadConfig` (see config.ts's
 * simulation block for why: whatever `loadConfig` can reach, an installed
 * app can be made to honour, and a flag that prints the person's own
 * prompts must never be a setting a packaged app carries). Unlike
 * `DWARFAI_PERF`, which is read at import time and so needs a real
 * environment variable, this one is read after index.ts's `loadDotenv()`,
 * so a repo `.env` line reaches it.
 *
 * The spellings mirror config.ts's `readFlag`: `1` or `true`, trimmed and
 * case-insensitive, is on; absence, blank, `0`, `false` and anything else
 * are off — the safe reading of an unconsidered answer is "print nothing",
 * here as it is for inventing mines.
 */
export function jevDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[JEV_DEBUG_ENV_VAR]
  if (raw === undefined) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
}

/**
 * Our own budget for "the launch must not hang". TypeSafe publishes no
 * latency figure for System One — a circulating "~100ms" is not in any
 * primary source (issue #509's own evidence section says so explicitly) —
 * so this is a product choice about acceptable launch delay, not a
 * measurement.
 */
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_MAX_RETRIES = 1

/**
 * Discards every call outright, regardless of `logLevel`. The SDK's own
 * `debug` level logs request bodies verbatim — `TypeSafeClientConfig.logLevel`
 * documents that bodies are not redacted — and a launch's body carries the
 * person's own prompt, so this app supplies a logger that cannot leak it
 * rather than trusting a level nobody here ever raises to `debug`.
 */
const SILENT_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

/**
 * `EntryType`/`ChoiceCriteria`/`NoulQuestion['criteria']` are the SDK's own
 * recursive JSON-value shapes — plain objects WITH an index signature. This
 * app's own named shapes for the same JSON (`JevQuestionInstructions`,
 * `JevChoiceCriteria`, `JevNoulSideCriteria` in routeRequest.ts) are not
 * STRUCTURALLY assignable to them for that reason alone, even though every
 * value each one ever holds is plain JSON `noul()`/`choice()` already
 * accept. A double cast, never a reshape: the object crosses unchanged,
 * only its TYPE is widened to the one those SDK helpers take.
 */
function asEntryType(value: unknown): EntryType {
  return value as EntryType
}
function asChoiceCriteria(value: unknown): ChoiceCriteria {
  return value as ChoiceCriteria
}
function asNoulCriteria(value: unknown): NoulQuestion['criteria'] {
  return value as NoulQuestion['criteria']
}

/**
 * Whether `value` is a real probability — verifier fix (#608): `typeof
 * value === 'number'` alone accepts `Infinity`, `-Infinity`, and anything
 * outside `0..1`, and would accept `NaN` too were it not already lossy
 * through `JSON.stringify`/`JSON.parse` (which turns a literal `NaN` into
 * `null`, itself caught by the `typeof` check). Used to validate every
 * Noul `noul` and every Choice `probabilities` entry `routeModel` reads,
 * so a malformed value from the wire degrades this ONE request to
 * `invalid-response` — never reaches `selectModelWinner`'s own
 * `Math.max`/tie-band arithmetic (routeDecision.ts) unnoticed.
 */
function isValidProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export interface CreateTypesafeJevRouterOptions {
  /** Reads the configured TypeSafe API key; undefined when none is set. */
  readKey: () => string | undefined
  /** Injected for tests — a hand-written fake, never `vi.mock` (skills/tdd). */
  fetch?: typeof fetch
  /** Per-attempt timeout in ms; see DEFAULT_TIMEOUT_MS for why 8000. */
  timeoutMs?: number
  /**
   * Dev-console trace sink for every routing call that got as far as having
   * a key (#525): one request line, then one answer or one fallback line, all
   * prefixed `[jev:debug]` and each a single line. It carries the person's
   * own prompt, so composition wires it only when JEV_DEBUG is on — and it
   * bypasses `SILENT_LOGGER` entirely rather than raising the SDK's log level,
   * whose debug mode dumps request bodies unredacted. The key appears in no
   * payload this sink ever receives.
   */
  debugLog?: (line: string) => void
}

/**
 * The `[jev:debug]` header+payload emitter (#525), and the clock behind
 * `elapsedMs` in every `fallback` line — factored out so `route` and #608's
 * `routeModel` build the IDENTICAL trace shape from one place rather than
 * two copies that could drift. An absent `debugLog` means zero output AND
 * zero clock reads, the same no-op-when-off shape perf.ts holds to.
 */
function createEmitter(debugLog: ((line: string) => void) | undefined): {
  elapsedMs: () => number
  emit: (header: string, payload: Record<string, unknown>) => void
} {
  const startedAt = debugLog === undefined ? undefined : Date.now()
  return {
    elapsedMs: () => (startedAt === undefined ? 0 : Date.now() - startedAt),
    emit: (header, payload) => {
      if (debugLog === undefined) return
      debugLog(`[jev:debug] ${header}`)
      debugLog(JSON.stringify(payload, null, 2))
    }
  }
}

/** The SDK client both `route` and `routeModel` talk through — one place decides its config. */
function createClient(apiKey: string, fetchOverride: typeof fetch | undefined): TypeSafeClient {
  return new TypeSafeClient({
    apiKey,
    ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
    logger: SILENT_LOGGER,
    logLevel: 'off',
    retry: { maxRetries: DEFAULT_MAX_RETRIES }
  })
}

/** The SDK adapter for JevRouterPort — see this module's own comment. */
export function createTypesafeJevRouter(options: CreateTypesafeJevRouterOptions): JevRouterPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async route(request: JevRouteRequest, { signal }): Promise<JevRouteOutcome> {
      const apiKey = options.readKey()
      // No network call at all without a key — never a request that can
      // only fail, and never a stray call this app cannot account for.
      if (apiKey === undefined) return { kind: 'fallback', reason: 'no-key' }

      // #525: the opt-in trace. Everything it says goes through `debugLog`
      // and nowhere else. The key is read above and names no payload below:
      // it must never be logged.
      //
      // AMENDED for jev-routing-profiles T4: one HEADER line (still single-
      // line and greppable — `grep '\[jev:debug\]'` finds one per event)
      // names what follows, then the payload is PRETTY-PRINTED
      // (`JSON.stringify(value, null, 2)`) as its own debugLog call — two
      // calls per event rather than one packed line, because a request or an
      // answer is meant to be READ on the dev console now, not only grepped.
      // The prompt is safe to print at either verbosity: this trace is
      // opt-in and dev-only (JEV_DEBUG), and the sink never receives the key
      // or the Authorization header — read above, named in no payload below.
      const { elapsedMs, emit } = createEmitter(options.debugLog)
      const client = createClient(apiKey, options.fetch)

      emit('request →', {
        state: { prompt: request.prompt, routing_profile: request.routingProfile },
        truncated: request.truncated,
        questions: {
          is_trivial: { instructions: IS_TRIVIAL_INSTRUCTIONS, criteria: IS_TRIVIAL_CRITERIA },
          needs_large_context: {
            instructions: NEEDS_LARGE_CONTEXT_INSTRUCTIONS,
            criteria: NEEDS_LARGE_CONTEXT_CRITERIA
          },
          provider: {
            instructions: PROVIDER_QUESTION_INSTRUCTIONS,
            criteria: request.providerCriteria
          },
          model_tier: {
            instructions: MODEL_TIER_QUESTION_INSTRUCTIONS,
            criteria: MODEL_TIER_CRITERIA
          },
          effort: { instructions: EFFORT_QUESTION_INSTRUCTIONS, criteria: EFFORT_RUBRIC }
        }
      })

      try {
        const result = await client.systemOne(
          {
            state: { prompt: request.prompt, routing_profile: request.routingProfile },
            model: 'jev-latest',
            questions: {
              is_trivial: noul(
                asEntryType(IS_TRIVIAL_INSTRUCTIONS),
                asNoulCriteria(IS_TRIVIAL_CRITERIA)
              ),
              needs_large_context: noul(
                asEntryType(NEEDS_LARGE_CONTEXT_INSTRUCTIONS),
                asNoulCriteria(NEEDS_LARGE_CONTEXT_CRITERIA)
              ),
              provider: choice(
                asEntryType(PROVIDER_QUESTION_INSTRUCTIONS),
                asChoiceCriteria(request.providerCriteria)
              ),
              model_tier: choice(
                asEntryType(MODEL_TIER_QUESTION_INSTRUCTIONS),
                asChoiceCriteria(MODEL_TIER_CRITERIA)
              ),
              effort: score(EFFORT_QUESTION_INSTRUCTIONS, EFFORT_RUBRIC)
            }
          },
          { signal, timeout: timeoutMs }
        )

        const providerAnswer = result.answers.provider
        const tierAnswer = result.answers.model_tier
        // The SDK types `choice` as one of the keys sent, but the wire is
        // never trusted on its own word: an id that fails to match one of
        // OUR OWN choices — for either Choice question — is an answer this
        // launch cannot act on, however it happened.
        if (
          !Object.keys(request.providerCriteria).includes(providerAnswer.choice) ||
          !(TIER_CHOICE_KEYS as readonly string[]).includes(tierAnswer.choice)
        ) {
          emit('fallback', { reason: 'invalid-response', elapsedMs: elapsedMs() })
          return { kind: 'fallback', reason: 'invalid-response' }
        }

        emit('answers ←', { ...result.answers, inputTokens: result.usage.input_tokens })

        return {
          kind: 'answers',
          provider: { choice: providerAnswer.choice, confidence: providerAnswer.confidence },
          tier: { choice: tierAnswer.choice, confidence: tierAnswer.confidence },
          trivial: { probability: result.answers.is_trivial.noul },
          largeContext: { probability: result.answers.needs_large_context.noul },
          effort: { score: result.answers.effort.score },
          usage: { inputTokens: result.usage.input_tokens }
        }
      } catch (error) {
        const reason = classifyError(error)
        emit('fallback', { reason, elapsedMs: elapsedMs() })
        return { kind: 'fallback', reason }
      }
    },

    /** #608's second request — see `JevModelRouteRequest`'s own comment in jevRouterPort.ts. */
    async routeModel(request: JevModelRouteRequest, { signal }): Promise<JevModelRouteOutcome> {
      const apiKey = options.readKey()
      if (apiKey === undefined) return { kind: 'fallback', reason: 'no-key' }

      const { elapsedMs, emit } = createEmitter(options.debugLog)
      const client = createClient(apiKey, options.fetch)

      const candidateKeys = Object.keys(request.candidates)
      const questions: Record<string, unknown> = {
        which: choice(
          asEntryType(modelChoiceInstructions(request.tier)),
          asChoiceCriteria(request.candidates)
        )
      }
      for (const key of candidateKeys) {
        questions[`fits::${key}`] = noul(
          asEntryType(modelFitInstructions(request.tier, request.candidates[key]!))
        )
      }

      emit('request →', {
        state: { prompt: request.prompt, routing_profile: request.routingProfile },
        truncated: request.truncated,
        questions
      })

      try {
        const result = await client.systemOne(
          {
            state: { prompt: request.prompt, routing_profile: request.routingProfile },
            model: 'jev-latest',
            // The SDK types `questions` against a fixed shape; #608's own
            // question set is built dynamically (one Noul per candidate), so
            // it is widened the same way `asEntryType`/`asChoiceCriteria`
            // already widen a single question's own instructions/criteria —
            // never a reshape, every value here is plain JSON `noul()`/
            // `choice()` already accept.
            questions: questions as never
          },
          { signal, timeout: timeoutMs }
        )

        const answers = result.answers as unknown as Record<
          string,
          { type: string; choice?: string; probabilities?: Record<string, number>; noul?: number }
        >
        const whichAnswer = answers.which
        // The wire is never trusted on its own word: a choice that fails to
        // match one of the candidates THIS request sent is an answer this
        // launch cannot act on, however it happened — the same discipline
        // `route`'s own provider/tier check already holds to.
        if (whichAnswer === undefined || !candidateKeys.includes(whichAnswer.choice ?? '')) {
          emit('fallback', { reason: 'invalid-response', elapsedMs: elapsedMs() })
          return { kind: 'fallback', reason: 'invalid-response' }
        }

        const fits: Record<string, number> = {}
        for (const key of candidateKeys) {
          const fitAnswer = answers[`fits::${key}`]
          if (fitAnswer === undefined || !isValidProbability(fitAnswer.noul)) {
            emit('fallback', { reason: 'invalid-response', elapsedMs: elapsedMs() })
            return { kind: 'fallback', reason: 'invalid-response' }
          }
          fits[key] = fitAnswer.noul
        }

        // Every reported Choice probability, not only the winner's own —
        // `selectModelWinner` reads the tied candidates' own shares too.
        const choiceProbabilities = whichAnswer.probabilities ?? {}
        if (!Object.values(choiceProbabilities).every(isValidProbability)) {
          emit('fallback', { reason: 'invalid-response', elapsedMs: elapsedMs() })
          return { kind: 'fallback', reason: 'invalid-response' }
        }

        emit('answers ←', { ...answers, inputTokens: result.usage.input_tokens })

        return {
          kind: 'answers',
          fits,
          choice: { choice: whichAnswer.choice!, probabilities: choiceProbabilities },
          usage: { inputTokens: result.usage.input_tokens }
        }
      } catch (error) {
        const reason = classifyError(error)
        emit('fallback', { reason, elapsedMs: elapsedMs() })
        return { kind: 'fallback', reason }
      }
    }
  }
}

/**
 * Every SDK failure this app knows the shape of, mapped to the one typed
 * reason a launch can act on. Order matters for exactly one pair:
 * `APITimeoutError` EXTENDS `APIConnectionError` (its own doc comment says
 * so), so it is checked first — reversing the order would read every
 * timeout as the more generic 'unreachable'. Exported so classifyError can
 * be pinned directly against constructed SDK errors, rather than only
 * through a live retry loop this app cannot fast-forward (see this file's
 * test).
 */
export function classifyError(error: unknown): JevFallbackReason {
  if (error instanceof AuthenticationError) return 'unauthorized'
  if (error instanceof RateLimitError) return 'rate-limited'
  if (error instanceof APIUserAbortError) return 'timeout'
  if (error instanceof APITimeoutError) return 'timeout'
  if (error instanceof InternalServerError) return 'unreachable'
  if (error instanceof APIConnectionError) return 'unreachable'
  // Everything else: a 4xx this app did not name above, a malformed
  // response, or a TypeSafeError raised on our own request shape (empty
  // questions, a score rubric under two entries) — never expected from a
  // request this module builds, but not this port's to throw either way.
  return 'invalid-response'
}
