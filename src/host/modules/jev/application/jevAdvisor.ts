// `JevAdvisor.suggest` (16 §4.9; 05 §3.9): one suggestion over the ISSUE-191 core. Per call it reads
// the routing profile and the configured default along the jev → preferences edge (05 §5.2 `EDGES`),
// and the providers the Host can launch now through `RoutingCatalogSource` (16 §4.9 "bridge →
// suppliers", the step's launchable list, never widened: 21 §2 cut 3 "Let Jev choose"). The core
// builds the request (ISSUE-190), asks the router and applies the decision; this file maps the
// outcome onto `JevSuggestionView` (06 §12): exactly the parts Jev decided, the per-part confidence
// and the truncated flag — never a permission mode, a reason sentence or a fallback supplier, and
// never stored (INV-87).
//
// - Inputs leave the Host only as the core builds them: the prompt and one criterion per launchable
//   provider (16 §6.2; C-26). No mine id, path, custom name or attachment is an input here at all.
// - A catalog provider the jev tables do not know is offered by its catalog label (R12,
//   US-LAUNCH-003.AC11): `RoutingProviderOption.label`.
// - No launchable provider: `jev-could-not-choose`, logged `jev.fallback` with the reason only
//   (19 §9.3), with no key read and nothing sent (ADR-020; the observe-only variant of 3a).
// - `purpose: 'launch'` with `effort-ceiling` is the fallback suggestion, not an error (16 §6.4); the
//   configured default it carries is ISSUE-193's (later), so here it names no part.
// - The prompt is never logged (14 §1.10).
import type { Result } from '../../../kernel/domain/values'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { SecretReader } from '../../../kernel/ports/secretReader'
import type { PreferencesQueries } from '../../preferences'
import type { SupplierEntry } from '../../suppliers'
import { MODEL_CAPABILITIES } from '../domain/capabilities/modelCapability'
import type { JevCapabilityTable, RoutingModelCatalog } from '../domain/routeDecision'
import type { JevModelPart, LaunchDecision, SettledModel } from '../domain/routeModel'
import type { RoutingProviderOption } from '../domain/routeRequest'
import type { JevPartOrigin, JevSuggestion } from '../domain/suggestion'
import type { JevRouter, RoutingCatalogSource } from '../ports/jevRouter'
import { createJevAdvisorCore, type JevAdvice, type JevAdvisorError } from './jevAdvisorCore'

/** 14 §3.6: the suggestion as seam A and seam B carry it (06 §12, transient, never persisted). */
export type JevSuggestionView = JevSuggestion

export type { JevAdvisorError }

// As 05 §3.9 writes it (16 §4.9; layout by prettier): the driving port.
export interface JevAdvisor {
  suggest(req: {
    prompt: string
    purpose: 'launch' | 'subtask'
    context?: string
  }): Promise<
    Result<JevSuggestionView, 'jev-unreachable' | 'jev-could-not-choose' | 'not-configured'>
  >
}

/** 16 §6.5: the signal that fires on Dismiss, an emptied or a changed prompt. */
export interface JevSuggestOptions {
  signal?: AbortSignal
}

/**
 * The advisor the Host composes: the 05 §3.9 port, whose `suggest` also takes the abort signal
 * 16 §6.5 says the advisor passes (an extra optional argument, so it is still a `JevAdvisor`).
 */
export interface AbortableJevAdvisor extends JevAdvisor {
  suggest(
    req: Parameters<JevAdvisor['suggest']>[0],
    opts?: JevSuggestOptions
  ): Promise<Result<JevSuggestionView, JevAdvisorError>>
}

export interface JevAdvisorDeps {
  router: JevRouter
  /** The kernel port the Jev key is read through, per suggestion (16 §4.9). */
  secrets: SecretReader
  routingCatalog: RoutingCatalogSource
  preferences: Pick<PreferencesQueries, 'get'>
  /** The capability table; the domain's own unless a caller passes one (OpenCode's derived one). */
  capabilities?: JevCapabilityTable
  log: DiagnosticsLog
}

/** The launch catalogue as the request builder reads it: every entry is launchable now. */
function providerOptions(entries: readonly SupplierEntry[]): RoutingProviderOption[] {
  return entries.map((entry) => ({
    provider: entry.providerId,
    installed: entry.installed,
    launchable: true,
    label: entry.label
  }))
}

/** Each launchable provider's live models, as the decision reads them (the catalog's own ids). */
function modelCatalogs(entries: readonly SupplierEntry[]): RoutingModelCatalog[] {
  return entries.map((entry) => ({
    provider: entry.providerId,
    models: entry.models.map((value) => ({ value })),
    efforts: entry.efforts,
    source: 'provider'
  }))
}

/**
 * The model part's origin on the view. `'only-candidate'` (one live candidate, no second request)
 * follows from the provider and tier: answered when both were, else it fell back with them.
 */
function modelOrigin(decided: LaunchDecision, part: JevModelPart): JevPartOrigin {
  if (part.applied !== 'only-candidate') return part.applied
  return decided.parts.provider.applied === 'answered' && decided.parts.tier.applied === 'answered'
    ? 'answered'
    : 'safe-default'
}

/** 06 §12: the decision as the view carries it, each part only when the decision names it. */
function toSuggestionView(
  decided: LaunchDecision,
  model: SettledModel,
  truncated: boolean
): JevSuggestionView {
  const provider = decided.parts.provider
  const tier = decided.parts.tier
  const view: JevSuggestionView = {
    providerId: decided.provider,
    confidence: {},
    truncated,
    parts: { providerId: provider.applied }
  }
  // A decision lands on a routing tier only; 'special-purpose' is a capability-table concept.
  if (decided.tier !== 'special-purpose') {
    view.tier = decided.tier
    view.parts.tier = tier.applied
    if (tier.applied === 'answered') view.confidence.tier = tier.confidence
  }
  if (provider.applied === 'answered') view.confidence.providerId = provider.confidence
  if (model.model !== undefined) {
    view.model = model.model
    view.parts.model = modelOrigin(decided, model.part)
    if (model.part.applied === 'answered' && model.part.probability !== undefined) {
      view.confidence.model = model.part.probability
    }
  }
  // The effort is Jev's own effort score on the picked model's ladder, capped (ADR-028).
  if (model.effort !== undefined) {
    view.effort = model.effort
    view.parts.effort = 'answered'
  }
  return view
}

function toResult(advice: JevAdvice): Result<JevSuggestionView, JevAdvisorError> {
  if (!advice.ok) return { ok: false, error: advice.error }
  if (advice.kind === 'fallback') {
    return {
      ok: true,
      value: { confidence: {}, truncated: false, parts: {}, fallback: advice.reason }
    }
  }
  return { ok: true, value: toSuggestionView(advice.decision, advice.model, advice.truncated) }
}

export function createJevAdvisor(deps: JevAdvisorDeps): AbortableJevAdvisor {
  const core = createJevAdvisorCore({ router: deps.router, secrets: deps.secrets })
  const capabilities = deps.capabilities ?? MODEL_CAPABILITIES

  async function suggest(
    req: Parameters<JevAdvisor['suggest']>[0],
    opts: JevSuggestOptions = {}
  ): Promise<Result<JevSuggestionView, JevAdvisorError>> {
    const launchable = await deps.routingCatalog.launchable()
    if (launchable.length === 0) {
      deps.log.record({
        level: 'warn',
        event: 'jev.fallback',
        subsystem: 'jev',
        outcome: 'skipped',
        causeClass: 'no-launchable-provider'
      })
      return { ok: false, error: 'jev-could-not-choose' }
    }
    const preferences = deps.preferences.get()
    const advice = await core.advise({
      purpose: req.purpose,
      // 16 §6.2: a subtask sends its text with its context (the found tree's `combinedPrompt`).
      prompt: req.context === undefined ? req.prompt : `${req.context}\n\n${req.prompt}`,
      profile: preferences.routingProfile,
      providers: providerOptions(launchable),
      catalogs: modelCatalogs(launchable),
      capabilities,
      userDefault: {
        ...(preferences.defaultProvider === undefined
          ? {}
          : { provider: preferences.defaultProvider }),
        ...(preferences.defaultModel === undefined ? {} : { model: preferences.defaultModel }),
        ...(preferences.defaultEffort === undefined ? {} : { effort: preferences.defaultEffort })
      },
      ...(opts.signal === undefined ? {} : { signal: opts.signal })
    })
    return toResult(advice)
  }

  return { suggest }
}
