import type {
  AgentModelCatalog,
  AgentProviderOption,
  JevFallbackReason,
  JevModelFallbackReason,
  JevPreferences,
  JevRouteLaunchRequest,
  JevRouteLaunchResult,
  JevRouteModelPart
} from '../domain/types'
import type { OpenCodeCatalogueModel } from '../providers/opencode/models'
import { MODEL_CAPABILITIES } from './capabilities/modelCapability'
import { mergeOpenCodeCapabilityTable } from './capabilities/opencode'
import { deriveOpenCodeCapabilities } from './capabilities/opencodeDerived'
import type { JevModelRouteOutcome, JevRouteOutcome, JevRouterPort } from './jevRouterPort'
import {
  decideLaunch,
  finalizeModel,
  minOfAnswered,
  selectModelWinner,
  type JevCapabilityTable,
  type JevDecideResult,
  type ModelSelectionCandidate
} from './routeDecision'
import { buildJevModelRouteRequest, buildJevRouteRequest } from './routeRequest'

/**
 * #608's own model step, over an already-resolved provider/tier decision:
 * no live candidate at all, exactly one (no second request), or two-or-more
 * (the second request, with its own budget check and every way it can fall
 * back). Kept as its own function — rather than inline in `route` below —
 * so the "what did the model step decide, and why" question has ONE answer
 * whether request 2 ran or not, mirrored into both the wire `model`/`effort`
 * and the honest `JevRouteModelPart` shown on the card.
 */
async function resolveModelPart(input: {
  router: JevRouterPort
  decided: Extract<JevDecideResult, { kind: 'decision' }>
  effortScore: number
  prompt: string
  routingProfile: JevPreferences['profile']
  totalBudgetMs: number
  startedAt: number
  now: () => number
  signal: AbortSignal
}): Promise<{ model?: string; effort?: string; part: JevRouteModelPart }> {
  const { decided } = input
  const candidates = decided.modelCandidates.options
  // decideLaunch's own pickModel/finalizeModel choice — already resolved,
  // and reused as the fallback value whenever request 2 is skipped, fails,
  // or its answer cannot be acted on. Guaranteed defined whenever
  // `candidates.length >= 1` (decideLaunch would have refused the whole
  // decision with 'invalid-response' otherwise — see its own comment).
  const safeDefault = { model: decided.model, effort: decided.effort }
  const safeDefaultPart = (reason: JevModelFallbackReason): JevRouteModelPart => ({
    ...(decided.model === undefined ? {} : { value: decided.model }),
    applied: 'safe-default',
    reason
  })

  if (candidates.length === 0) {
    return { ...safeDefault, part: safeDefaultPart('no-live-model') }
  }
  if (candidates.length === 1) {
    return { ...safeDefault, part: { value: candidates[0]!.id, applied: 'only-candidate' } }
  }

  // Both requests share ONE total budget (#608's own decision) — request 2
  // gets whatever is left of it, and is skipped entirely, never even sent,
  // once nothing is left.
  const remainingMs = input.totalBudgetMs - (input.now() - input.startedAt)
  if (remainingMs <= 0) {
    return { ...safeDefault, part: safeDefaultPart('budget-exceeded') }
  }

  const built = buildJevModelRouteRequest({
    prompt: input.prompt,
    routingProfile: input.routingProfile,
    tier: decided.modelCandidates.tier,
    candidates
  })
  if (built.kind === 'skip') {
    return { ...safeDefault, part: safeDefaultPart(built.reason) }
  }

  const outcome: JevModelRouteOutcome = await Promise.race([
    input.router.routeModel(built.request, { signal: input.signal }),
    timeoutOutcome(input.signal)
  ])
  if (outcome.kind === 'fallback') {
    return { ...safeDefault, part: safeDefaultPart(outcome.reason) }
  }

  const selectionCandidates: ModelSelectionCandidate[] = candidates.map((candidate, index) => ({
    key: String(index),
    id: candidate.id,
    entry: candidate.entry
  }))
  const selection = selectModelWinner(
    selectionCandidates,
    outcome.fits,
    outcome.choice,
    input.routingProfile
  )
  if (selection === undefined) {
    // Not reachable — candidates.length >= 2 here, and selectModelWinner is
    // only ever undefined for an empty list. Belt and braces.
    return { ...safeDefault, part: safeDefaultPart('invalid-response') }
  }

  const finalized = finalizeModel(
    decided.provider,
    selection.candidate.id,
    selection.candidate.entry,
    input.effortScore
  )
  if (finalized === undefined) {
    // The same belt-and-braces discipline `finalizeModel` already holds for
    // decideLaunch's OWN pick — a derived (model, effort) pairing the launch
    // gate would refuse is never carried out, request-2 winner or not.
    return { ...safeDefault, part: safeDefaultPart('invalid-response') }
  }

  return {
    model: finalized.model,
    effort: finalized.effort,
    part: {
      value: finalized.model,
      applied: 'answered',
      probability: selection.probability,
      ...(selection.choiceProbability === undefined
        ? {}
        : { choiceProbability: selection.choiceProbability })
    }
  }
}

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
 * doing with it. Racing this against `router.route()`/`router.routeModel()`
 * is what makes the budget absolute — a router that does not honour the
 * signal still cannot make this service wait past it. Typed as the minimal
 * shared shape rather than either specific outcome union, so ONE function
 * races against both requests (#608) — a plain `{kind:'fallback', reason:
 * 'timeout'}` is a valid member of both `JevRouteOutcome` and
 * `JevModelRouteOutcome`.
 */
function timeoutOutcome(signal: AbortSignal): Promise<{ kind: 'fallback'; reason: 'timeout' }> {
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

      // #608: ONE controller/timer for the WHOLE call — request 1 AND
      // request 2 race against the SAME absolute deadline, so "request 2
      // gets whatever remains" falls out of reusing this signal rather than
      // computing a second budget. Cleared once, at the very end, so the
      // deadline still governs request 2 even after request 1 settles.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), totalBudgetMs)
      try {
        const outcome: JevRouteOutcome = await Promise.race([
          options.router.route(built.request, { signal: controller.signal }),
          timeoutOutcome(controller.signal)
        ])

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
        if (decided.kind === 'fallback') {
          return fallback(decided.reason)
        }

        const modelPart = await resolveModelPart({
          router: options.router,
          decided,
          effortScore: outcome.effort.score,
          prompt: request.prompt,
          routingProfile: preferences.profile,
          totalBudgetMs,
          startedAt,
          now,
          signal: controller.signal
        })

        const result: JevRouteLaunchResult = {
          kind: 'decision',
          provider: decided.provider,
          ...(modelPart.model === undefined ? {} : { model: modelPart.model }),
          ...(modelPart.effort === undefined ? {} : { effort: modelPart.effort }),
          // The function-calling cookbook's own rule, over every part
          // (provider/tier/model) actually `applied: 'answered'` — see
          // `minOfAnswered`'s own comment. `decided.confidence` is already
          // the provider/tier half of this; the model part folds in here,
          // never inside `decideLaunch` itself, since only THIS call knows
          // whether request 2 was even sent.
          confidence: minOfAnswered(
            decided.confidence,
            modelPart.part.applied === 'answered' ? modelPart.part.probability : undefined
          ),
          truncated: built.request.truncated,
          tier: decided.tier,
          parts: {
            provider: decided.parts.provider,
            tier: decided.parts.tier,
            trivial: decided.parts.trivial,
            largeContext: decided.parts.largeContext,
            model: modelPart.part
          }
        }

        if (options.debugLog !== undefined) {
          options.debugLog('[jev:debug] decision =')
          options.debugLog(JSON.stringify({ ...result, elapsedMs: now() - startedAt }, null, 2))
        }

        return result
      } finally {
        clearTimeout(timer)
      }
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
