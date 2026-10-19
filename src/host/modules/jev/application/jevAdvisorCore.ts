// The advisor core (16 §4.9 `JevAdvisor.suggest`, §6.4, §6.5): one suggestion, end to end, over the
// `JevRouter` port. It builds the first request (ISSUE-190), reads the Jev key through the kernel
// SecretReader inside this suggestion only (ADR-017 item 3; US-RES-006.AC04: nothing checks the key
// unless Jev is asked), asks the router, applies the launch decision and the model step, and maps
// every fallback reason to the advisor's three errors (16 §6.4). Any error leaves no suggestion
// (INV-87); so does an abort, which the router answers as a fallback.
//
// `jev.suggest`, the routing-profile and catalog reads, and the mapping to `JevSuggestion` are the
// advisor's (ISSUE-192); the key and the prompt are never logged here (the router logs
// `jev.fallback` with the reason only, 19 §9.3).
import type { JevFallbackReason } from '../../../kernel/domain/sharedContracts'
import type { SecretReader } from '../../../kernel/ports/secretReader'
import {
  decideLaunch,
  type EffortLadders,
  type JevCapabilityTable,
  type RoutingLaunchDefault,
  type RoutingModelCatalog
} from '../domain/routeDecision'
import {
  overallConfidence,
  planModelStep,
  safeDefaultModel,
  settleModelStep,
  type LaunchDecision,
  type SettledModel
} from '../domain/routeModel'
import {
  buildJevModelRouteRequest,
  buildJevRouteRequest,
  type RoutingProviderOption
} from '../domain/routeRequest'
import type { JevRoutingProfile } from '../domain/suggestion'
import type { JevRouter } from '../ports/jevRouter'

/** 16 §4.9: the errors of `JevAdvisor.suggest`. */
export type JevAdvisorError = 'jev-unreachable' | 'jev-could-not-choose' | 'not-configured'

/** One suggestion's inputs, read fresh by the caller (ISSUE-192). */
export interface JevAdviceRequest {
  purpose: 'launch' | 'subtask'
  /** The prompt as typed (launch) or the subtask text and context (16 §6.2). */
  prompt: string
  profile: JevRoutingProfile
  /** The launchable providers (`RoutingCatalogSource`), in the catalog's own order. */
  providers: readonly RoutingProviderOption[]
  catalogs: readonly RoutingModelCatalog[]
  capabilities: JevCapabilityTable
  userDefault: RoutingLaunchDefault
  /** Fires on Dismiss, an emptied or a changed prompt (16 §6.5). */
  signal?: AbortSignal
}

export type JevAdvice =
  | {
      ok: true
      kind: 'decision'
      /** The first request's decision (provider, tier and their parts). */
      decision: LaunchDecision
      /** The model step's outcome (the second request, or why none was used). */
      model: SettledModel
      /** The minimum over every answered part (`overallConfidence`). */
      confidence?: number
      /** The prompt sent to Jev was trimmed to fit its request budget. */
      truncated: boolean
    }
  /** Launch only: every candidate is above the effort ceiling, so the fallback suggestion (16 §4.9). */
  | { ok: true; kind: 'fallback'; reason: 'effort-ceiling' }
  | { ok: false; error: JevAdvisorError; reason: JevFallbackReason }

export interface JevAdvisorCoreDeps {
  router: JevRouter
  secrets: SecretReader
  /** The effort ladders; the domain's own unless a test passes others. */
  effortLadders?: EffortLadders
}

export interface JevAdvisorCore {
  advise(req: JevAdviceRequest): Promise<JevAdvice>
}

/** 16 §6.4, the `JevAdvisor` error column (an `effort-ceiling` launch never reaches it). */
export function jevAdvisorErrorFor(reason: JevFallbackReason): JevAdvisorError {
  switch (reason) {
    case 'unreachable':
    case 'timeout':
    case 'rate-limited':
    case 'invalid-response':
      return 'jev-unreachable'
    case 'no-key':
      return 'not-configured'
    case 'unauthorized':
    case 'low-confidence':
    case 'budget-exceeded':
    case 'no-launchable-provider':
    case 'effort-ceiling':
      return 'jev-could-not-choose'
  }
}

const failed = (reason: JevFallbackReason): JevAdvice => ({
  ok: false,
  error: jevAdvisorErrorFor(reason),
  reason
})

/** An aborted suggestion leaves nothing behind (INV-87), whatever the router answered meanwhile. */
const ABORTED = failed('timeout')

export function createJevAdvisorCore(deps: JevAdvisorCoreDeps): JevAdvisorCore {
  const effortLadders =
    deps.effortLadders === undefined ? {} : { effortLadders: deps.effortLadders }

  /** ADR-028 D2 per path: a launch keeps the fallback suggestion, a subtask cannot choose. */
  const effortCeiling = (purpose: JevAdviceRequest['purpose']): JevAdvice =>
    purpose === 'launch'
      ? { ok: true, kind: 'fallback', reason: 'effort-ceiling' }
      : failed('effort-ceiling')

  async function advise(req: JevAdviceRequest): Promise<JevAdvice> {
    const { signal } = req
    // A function, not a narrowed field: the signal can fire during any await below.
    const aborted = (): boolean => signal?.aborted === true
    const built = buildJevRouteRequest({
      prompt: req.prompt,
      routingProfile: req.profile,
      providers: req.providers,
      capabilities: req.capabilities
    })
    // Nothing to ask about: no key is read and nothing is sent.
    if (built.kind === 'skip') return failed(built.reason)

    // Read here, per suggestion, and held only for its two requests (16 §6.2).
    const key = await deps.secrets.read('jev-key')
    if (key === null) return failed('no-key')
    if (key === 'timeout') return failed('timeout')
    if (aborted()) return ABORTED

    const opts = signal === undefined ? {} : { signal }
    const first = await deps.router.route(built.request, key, opts)
    if (aborted()) return ABORTED
    if (first.kind === 'fallback') return failed(first.reason)

    const decided = decideLaunch({
      answers: first,
      profile: req.profile,
      providers: req.providers,
      catalogs: req.catalogs,
      capabilities: req.capabilities,
      userDefault: req.userDefault,
      ...effortLadders
    })
    if (decided.kind === 'fallback') {
      return decided.reason === 'effort-ceiling'
        ? effortCeiling(req.purpose)
        : failed(decided.reason)
    }

    const plan = planModelStep(decided)
    let model: SettledModel
    if (plan.kind === 'model') {
      model = plan
    } else {
      const second = buildJevModelRouteRequest({
        prompt: req.prompt,
        routingProfile: req.profile,
        tier: plan.tier,
        candidates: plan.candidates
      })
      if (second.kind === 'skip') {
        model = safeDefaultModel(decided, second.reason)
      } else {
        const response = await deps.router.routeModel(second.request, key, opts)
        if (aborted()) return ABORTED
        const settled = settleModelStep({
          decided,
          response,
          effortScore: first.effort.score,
          profile: req.profile,
          ...effortLadders
        })
        if (settled.kind === 'fallback') return effortCeiling(req.purpose)
        model = settled
      }
    }

    const confidence = overallConfidence(decided, model.part)
    return {
      ok: true,
      kind: 'decision',
      decision: decided,
      model,
      ...(confidence === undefined ? {} : { confidence }),
      truncated: built.request.truncated
    }
  }

  return { advise }
}
