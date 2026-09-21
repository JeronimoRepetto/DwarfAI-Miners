import type {
  AgentModelCatalog,
  AgentProviderOption,
  JevFallbackReason,
  JevPreferences,
  JevRouteLaunchRequest,
  JevRouteLaunchResult
} from '../domain/types'
import { MODEL_CAPABILITIES } from './capabilities/modelCapability'
import type { JevRouteOutcome, JevRouterPort } from './jevRouterPort'
import { decideLaunch } from './routeDecision'
import { buildJevRouteRequest } from './routeRequest'

/**
 * The main-side service behind the `jev:route` IPC channel (#509): turns one
 * launch prompt into a routing SUGGESTION — never a launch itself, see
 * `JevRouteLaunchResult`'s own comment in contracts.ts — by asking the
 * injected `JevRouterPort` for Jev's own answers and `routeDecision.ts`'s
 * `decideLaunch` for what they mean, before either is ever shown.
 *
 * `listProviders`/`listModels`/`readPreferences` are asked FRESH on every
 * call, exactly like `useAgentLaunch.open` on the renderer side: the choice
 * set has to be what this machine can launch RIGHT NOW, not a snapshot from
 * whenever this service was composed — a CLI can be installed or removed,
 * and Settings' Jev section can change, between one launch and the next.
 *
 * request v2 (jev-routing-profiles T3) drops the old belt-and-braces
 * "is the decided provider still launchable" re-check that lived here: the
 * SAME `providers` list this call fetched is what `decideLaunch` derives its
 * OWN provider from (never outside `launchableProviders`), so the property
 * is now held by construction rather than by a second, redundant check.
 */

/**
 * This app's OWN ceiling on one route call, wall-clock — deliberately
 * separate from whatever per-attempt timeout and retry the SDK adapter runs
 * underneath (`typesafeJevRouter.ts`'s own `DEFAULT_TIMEOUT_MS` and
 * `DEFAULT_MAX_RETRIES`). A launch must never wait longer than THIS, whatever
 * the SDK does with its own retries inside that window. The adapter owns no
 * clock of its own on purpose: one place decides how long a launch may wait,
 * and it is this one (a product decision, recorded in the commit that introduced it).
 */
const DEFAULT_TOTAL_BUDGET_MS = 15_000

export interface CreateJevLaunchRouterOptions {
  router: JevRouterPort
  /** The launchable providers, asked fresh — never a snapshot from composition time. */
  listProviders: () => Promise<AgentProviderOption[]>
  /** Every provider's own model catalogue, asked fresh — same reason as `listProviders`. */
  listModels: () => Promise<AgentModelCatalog[]>
  /** The routing profile and default launch Settings holds, asked fresh — same reason as `listProviders`. */
  readPreferences: () => Promise<JevPreferences>
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
      const [providers, models, preferences] = await Promise.all([
        options.listProviders(),
        options.listModels(),
        options.readPreferences()
      ])
      const userDefault = preferences.default

      // Every fallback this call ever returns goes through here, so the
      // user's own configured default is attached uniformly — whether Jev
      // could not be asked at all (no-key, unreachable, timeout, ...) or
      // `decideLaunch` itself refused a derived pairing. Absent exactly when
      // no default is configured, which keeps today's behaviour unchanged
      // (the decisions doc's own words: "If no default is set, today's
      // behaviour stays").
      const fallback = (reason: JevFallbackReason, confidence?: number): JevRouteLaunchResult => ({
        kind: 'fallback',
        reason,
        ...(confidence === undefined ? {} : { confidence }),
        ...(userDefault.provider === undefined ? {} : { fallbackTo: userDefault })
      })

      const built = buildJevRouteRequest({
        prompt: request.prompt,
        routingProfile: preferences.profile,
        providers
      })
      if (built.kind === 'skip') {
        // Both of buildJevRouteRequest's own skip reasons ('no-launchable-provider',
        // 'budget-exceeded') are already members of JevFallbackReason, so this
        // is a direct pass-through rather than a second mapping to keep in step.
        return fallback(built.reason)
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
        return fallback(outcome.reason, outcome.confidence)
      }

      const decided = decideLaunch({
        answers: outcome,
        profile: preferences.profile,
        providers,
        catalogs: models,
        capabilities: MODEL_CAPABILITIES,
        userDefault
      })
      if (decided.kind === 'fallback') {
        return fallback(decided.reason)
      }

      return { ...decided, truncated: built.request.truncated }
    } catch (error) {
      // Never thrown onward — a launch must always have something honest to
      // fall back to. Logged WITHOUT the prompt, only how long the call ran.
      // No `fallbackTo` here: the failure may be the preferences read itself,
      // so this is the one fallback that never guesses a default it could
      // not actually confirm.
      console.warn(`[jev] Route request failed after ${now() - startedAt}ms:`, error)
      return { kind: 'fallback', reason: 'invalid-response' }
    }
  }

  return { route }
}
