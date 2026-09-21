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
      // and nowhere else, so an absent sink means zero output AND zero clock
      // reads — the same no-op-when-off shape perf.ts holds to. The key is
      // read above and names no payload below: it must never be logged.
      const debugLog = options.debugLog
      const startedAt = debugLog === undefined ? undefined : Date.now()
      const elapsedMs = (): number => (startedAt === undefined ? 0 : Date.now() - startedAt)
      const emit = (event: string, payload: Record<string, unknown>): void => {
        if (debugLog === undefined) return
        // JSON.stringify escapes newlines inside `state`, so one emit is
        // one physical line no matter what the person typed.
        debugLog(`[jev:debug] ${event} ${JSON.stringify(payload)}`)
      }

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

      emit('request', {
        state: request.state,
        truncated: request.truncated,
        choices: modelCriteria
      })

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
        if (chosen === undefined) {
          emit('fallback', { reason: 'invalid-response', elapsedMs: elapsedMs() })
          return { kind: 'fallback', reason: 'invalid-response' }
        }

        if (modelAnswer.confidence < JEV_MIN_CONFIDENCE) {
          emit('fallback', {
            reason: 'low-confidence',
            confidence: modelAnswer.confidence,
            elapsedMs: elapsedMs()
          })
          return { kind: 'fallback', reason: 'low-confidence', confidence: modelAnswer.confidence }
        }

        const effortAnswer = result.answers.effort
        const effort = mapEffortScore(chosen.provider, effortAnswer.score, PROVIDER_EFFORT_LEVELS)

        emit('answer', {
          choice: chosen.key,
          confidence: modelAnswer.confidence,
          effortScore: effortAnswer.score,
          inputTokens: result.usage.input_tokens
        })

        return {
          kind: 'decision',
          provider: chosen.provider,
          ...(chosen.model === undefined ? {} : { model: chosen.model }),
          ...(effort === undefined ? {} : { effort }),
          confidence: modelAnswer.confidence,
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
