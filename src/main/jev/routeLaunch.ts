import type {
  AgentModelCatalog,
  AgentProviderOption,
  JevFallbackReason,
  JevPreferences,
  JevRouteLaunchRequest,
  JevRouteLaunchResult
} from '../domain/types'
import type { OpenCodeCatalogueModel } from '../providers/opencode/models'
import { MODEL_CAPABILITIES } from './capabilities/modelCapability'
import { mergeOpenCodeCapabilityTable } from './capabilities/opencode'
import { deriveOpenCodeCapabilities } from './capabilities/opencodeDerived'
import type { JevRouteOutcome, JevRouterPort } from './jevRouterPort'
import { decideLaunch, type JevCapabilityTable } from './routeDecision'
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
  /**
   * OpenCode's own RAW live catalogue (#547) — a sibling of `listModels`,
   * not a replacement: `listModels`' `AgentModelCatalog` shape only carries
   * what the Add Panel needs (`ModelOption`), which drops the cost/limit/
   * capabilities/status facts `deriveOpenCodeCapabilities` below needs to
   * build OpenCode's own Jev capability table at route time. Asked fresh, on
   * the same terms as `listProviders`/`listModels`. Optional so every
   * existing test and caller that has nothing to say about OpenCode keeps
   * working unchanged; defaults to `[]`, the same "nothing derived, nothing
   * offered" answer an unavailable catalogue already produces.
   */
  readOpenCodeCatalogue?: () => Promise<readonly OpenCodeCatalogueModel[]>
  /** Overridable for tests; see `DEFAULT_TOTAL_BUDGET_MS` for why 15000. */
  totalBudgetMs?: number
  /** Injected clock, so a failure log can note how long the call ran without a real timer. */
  now?: () => number
  /**
   * Dev-console trace sink for the LOCAL decision (#525/jev-routing-profiles
   * T4): one header line, `[jev:debug] decision =`, then `decideLaunch`'s own
   * result pretty-printed (`JSON.stringify(value, null, 2)`) with `elapsedMs`
   * appended — this service's own wall-clock, read through `now` above.
   * Fires only once Jev actually answered (`outcome.kind === 'answers'`):
   * a request `buildJevRouteRequest` skipped, or a fallback Jev's OWN call
   * returned, never reaches `decideLaunch`, so there is no local decision to
   * show for either. Wired to the identical sink the SDK adapter takes
   * (main/index.ts) — see `typesafeJevRouter.ts`'s own
   * `CreateTypesafeJevRouterOptions.debugLog` comment for why printing this
   * is safe: opt-in, dev-only, and `decideLaunch`'s result never carries the
   * prompt or the key.
   */
  debugLog?: (line: string) => void
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

/** `YYYY-MM-DD` off an epoch-ms clock reading — the same date shape every curated capability entry's own `verifiedOn` already uses. */
function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

/**
 * The per-install capability table (#547): the three curated static tables
 * unchanged, plus OpenCode's own — derived fresh from `openCodeCatalogue`
 * (the live read this call just made) and merged with its curated overlay,
 * the overlay winning per id. Built fresh on every `route()` call, same
 * reason `providers`/`models`/`preferences` are: OpenCode's install-specific
 * catalogue can only be trusted as of THIS read.
 */
function assembleCapabilities(
  openCodeCatalogue: readonly OpenCodeCatalogueModel[],
  readAtIso: string
): JevCapabilityTable {
  return {
    claude: MODEL_CAPABILITIES.claude,
    codex: MODEL_CAPABILITIES.codex,
    antigravity: MODEL_CAPABILITIES.antigravity,
    opencode: mergeOpenCodeCapabilityTable(deriveOpenCodeCapabilities(openCodeCatalogue, readAtIso))
  }
}

/** The main-side service — see this module's own comment. */
export function createJevLaunchRouter(options: CreateJevLaunchRouterOptions): JevLaunchRouter {
  const totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS
  const now = options.now ?? Date.now
  const readOpenCodeCatalogue = options.readOpenCodeCatalogue ?? (async () => [])

  async function route(request: JevRouteLaunchRequest): Promise<JevRouteLaunchResult> {
    const startedAt = now()
    try {
      const [providers, models, preferences, openCodeCatalogue] = await Promise.all([
        options.listProviders(),
        options.listModels(),
        options.readPreferences(),
        // Unavailable stays honest (#547): a rejecting/throwing seam never
        // fails the whole route call — it degrades to the same `[]` a
        // healthy-but-empty catalogue already produces, so OpenCode's own
        // provider option is simply omitted rather than the launch falling
        // back on account of a catalogue read nothing else here needed.
        readOpenCodeCatalogue().catch((error: unknown) => {
          console.warn(
            "[jev] Could not read OpenCode's own live catalogue, routing without it",
            error
          )
          return []
        })
      ])
      const userDefault = preferences.default
      const capabilities = assembleCapabilities(openCodeCatalogue, isoDate(now()))

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
        providers,
        capabilities
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
        capabilities,
        userDefault
      })
      if (options.debugLog !== undefined) {
        options.debugLog('[jev:debug] decision =')
        options.debugLog(JSON.stringify({ ...decided, elapsedMs: now() - startedAt }, null, 2))
      }
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
