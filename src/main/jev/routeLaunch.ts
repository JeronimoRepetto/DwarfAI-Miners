import { parseLaunchTuning, PROVIDER_EFFORT_LEVELS } from '../domain/launchTuning'
import type {
  AgentModelCatalog,
  AgentProviderOption,
  JevRouteLaunchRequest,
  JevRouteLaunchResult
} from '../domain/types'
import type { JevRouteOutcome, JevRouterPort } from './jevRouterPort'
import { buildJevRouteRequest } from './routeRequest'

/**
 * The main-side service behind the `jev:route` IPC channel (#509): turns one
 * launch prompt into a routing SUGGESTION — never a launch itself, see
 * `JevRouteLaunchResult`'s own comment in contracts.ts — by asking the
 * injected `JevRouterPort` and validating whatever it answers before it is
 * ever shown.
 *
 * `listProviders`/`listModels` are asked FRESH on every call, exactly like
 * `useAgentLaunch.open` on the renderer side: the choice set has to be what
 * this machine can launch RIGHT NOW, not a catalogue snapshot from whenever
 * this service was composed, because a CLI can be installed or removed
 * between one launch and the next.
 */

/**
 * This app's OWN ceiling on one route call, wall-clock — deliberately
 * separate from whatever per-attempt timeout and retry the SDK adapter runs
 * underneath (`typesafeJevRouter.ts`'s own `DEFAULT_TIMEOUT_MS` and
 * `DEFAULT_MAX_RETRIES`). A launch must never wait longer than THIS, whatever
 * the SDK does with its own retries inside that window. The adapter owns no
 * clock of its own on purpose: one place decides how long a launch may wait,
 * and it is this one (recorded in odd/tasks/jev-launch-routing.md).
 */
const DEFAULT_TOTAL_BUDGET_MS = 15_000

export interface CreateJevLaunchRouterOptions {
  router: JevRouterPort
  /** The launchable providers, asked fresh — never a snapshot from composition time. */
  listProviders: () => Promise<AgentProviderOption[]>
  /** Every provider's own model catalogue, asked fresh — same reason as `listProviders`. */
  listModels: () => Promise<AgentModelCatalog[]>
  /** Overridable for tests; see `DEFAULT_TOTAL_BUDGET_MS` for why 15000. */
  totalBudgetMs?: number
  /** Injected clock, so a failure log can note how long the call ran without a real timer. */
  now?: () => number
}

export interface JevLaunchRouter {
  route(request: JevRouteLaunchRequest): Promise<JevRouteLaunchResult>
}

/**
 * Resolves once the given signal aborts, with the one outcome an abort ever
 * means here: this app's own budget ran out, whatever the router itself was
 * doing with it. Racing this against `router.route()` is what makes the
 * budget absolute — a router that does not honour the signal still cannot
 * make this service wait past it.
 */
function timeoutOutcome(signal: AbortSignal): Promise<JevRouteOutcome> {
  return new Promise((resolve) => {
    const settle = (): void => resolve({ kind: 'fallback', reason: 'timeout' })
    if (signal.aborted) {
      settle()
      return
    }
    signal.addEventListener('abort', settle, { once: true })
  })
}

/** The main-side service — see this module's own comment. */
export function createJevLaunchRouter(options: CreateJevLaunchRouterOptions): JevLaunchRouter {
  const totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS
  const now = options.now ?? Date.now

  async function route(request: JevRouteLaunchRequest): Promise<JevRouteLaunchResult> {
    const startedAt = now()
    try {
      const [providers, models] = await Promise.all([options.listProviders(), options.listModels()])

      const built = buildJevRouteRequest({
        prompt: request.prompt,
        providers,
        catalogs: models,
        effortLevels: PROVIDER_EFFORT_LEVELS
      })
      if (built.kind === 'skip') {
        // Both of buildJevRouteRequest's own skip reasons ('no-launchable-provider',
        // 'budget-exceeded') are already members of JevFallbackReason, so this
        // is a direct pass-through rather than a second mapping to keep in step.
        return { kind: 'fallback', reason: built.reason }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), totalBudgetMs)
      let outcome: JevRouteOutcome
      try {
        outcome = await Promise.race([
          options.router.route(built.request, { signal: controller.signal }),
          timeoutOutcome(controller.signal)
        ])
      } finally {
        clearTimeout(timer)
      }

      if (outcome.kind === 'fallback') {
        return {
          kind: 'fallback',
          reason: outcome.reason,
          ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence })
        }
      }

      // A decision this app's own launch gate refuses is never carried out —
      // the choice set came from the live catalogue, but parseLaunchTuning is
      // the single source of truth for what a launch actually accepts (see
      // launchTuning.ts's own module comment).
      const stillLaunchable = providers.some(
        (option) => option.provider === outcome.provider && option.launchable
      )
      if (!stillLaunchable) {
        // Belt and braces: buildJevRouteRequest only ever offers launchable
        // providers as choices, but the live set could have changed between
        // building the request and the router's answer coming back.
        return { kind: 'fallback', reason: 'invalid-response' }
      }
      const tuning = parseLaunchTuning(outcome.provider, {
        ...(outcome.model === undefined ? {} : { model: outcome.model }),
        ...(outcome.effort === undefined ? {} : { effort: outcome.effort })
      })
      if (tuning === null) {
        return { kind: 'fallback', reason: 'invalid-response' }
      }

      return {
        kind: 'decision',
        provider: outcome.provider,
        ...(tuning.model === undefined ? {} : { model: tuning.model }),
        ...(tuning.effort === undefined ? {} : { effort: tuning.effort }),
        confidence: outcome.confidence,
        truncated: built.request.truncated
      }
    } catch (error) {
      // Never thrown onward — a launch must always have something honest to
      // fall back to. Logged WITHOUT the prompt, only how long the call ran.
      console.warn(`[jev] Route request failed after ${now() - startedAt}ms:`, error)
      return { kind: 'fallback', reason: 'invalid-response' }
    }
  }

  return { route }
}
