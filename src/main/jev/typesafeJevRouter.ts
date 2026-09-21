import {
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  InternalServerError,
  RateLimitError,
  TypeSafeClient,
  choice,
  score,
  type Logger
} from '@typesafe-ai/sdk'
import { PROVIDER_EFFORT_LEVELS } from '../domain/launchTuning'
import type {
  JevFallbackReason,
  JevRouteOutcome,
  JevRouteRequest,
  JevRouterPort
} from './jevRouterPort'
import {
  EFFORT_QUESTION_INSTRUCTIONS,
  EFFORT_RUBRIC,
  MODEL_QUESTION_INSTRUCTIONS,
  mapEffortScore
} from './routeRequest'

/**
 * The SDK adapter for JevRouterPort (issue #509), over `@typesafe-ai/sdk`
 * 0.6.0. Verified against docs.typesafe.ai and, ultimately, this repo's own
 * `node_modules/.pnpm/@typesafe-ai+sdk@0.6.0/.../dist/index.d.mts` — the
 * type declarations are the ground truth this module was written against.
 */

/**
 * Below this, a `model` decision degrades to the manual pickers instead of
 * being acted on — issue #509's own acceptance criterion ("When Jev ...
 * returns low confidence, the launch still happens using the pickers'
 * current values"). A product default to tune from observed runs, not a
 * measured constant: nothing published states where real answers cluster.
 */
export const JEV_MIN_CONFIDENCE = 0.5

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

export interface CreateTypesafeJevRouterOptions {
  /** Reads the configured TypeSafe API key; undefined when none is set. */
  readKey: () => string | undefined
  /** Injected for tests — a hand-written fake, never `vi.mock` (skills/tdd). */
  fetch?: typeof fetch
  /** Per-attempt timeout in ms; see DEFAULT_TIMEOUT_MS for why 8000. */
  timeoutMs?: number
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

      const client = new TypeSafeClient({
        apiKey,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        logger: SILENT_LOGGER,
        logLevel: 'off',
        retry: { maxRetries: DEFAULT_MAX_RETRIES }
      })

      const modelCriteria = Object.fromEntries(
        request.modelChoices.map((entry) => [entry.key, entry.criteria])
      )

      try {
        const result = await client.systemOne(
          {
            state: request.state,
            model: 'jev-latest',
            questions: {
              model: choice(MODEL_QUESTION_INSTRUCTIONS, modelCriteria),
              effort: score(EFFORT_QUESTION_INSTRUCTIONS, EFFORT_RUBRIC)
            }
          },
          { signal, timeout: timeoutMs }
        )

        const modelAnswer = result.answers.model
        const chosen = request.modelChoices.find((entry) => entry.key === modelAnswer.choice)
        // The SDK types `choice` as one of the keys sent, but the wire is
        // never trusted on its own word: an id that fails to match one of
        // OUR OWN choices is an answer this launch cannot act on, however it
        // happened.
        if (chosen === undefined) return { kind: 'fallback', reason: 'invalid-response' }

        if (modelAnswer.confidence < JEV_MIN_CONFIDENCE) {
          return { kind: 'fallback', reason: 'low-confidence', confidence: modelAnswer.confidence }
        }

        const effortAnswer = result.answers.effort
        const effort = mapEffortScore(chosen.provider, effortAnswer.score, PROVIDER_EFFORT_LEVELS)

        return {
          kind: 'decision',
          provider: chosen.provider,
          ...(chosen.model === undefined ? {} : { model: chosen.model }),
          ...(effort === undefined ? {} : { effort }),
          confidence: modelAnswer.confidence,
          usage: { inputTokens: result.usage.input_tokens }
        }
      } catch (error) {
        return { kind: 'fallback', reason: classifyError(error) }
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
