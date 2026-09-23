import type { JevFallbackReason, JevRoutingProfile, ModelTier } from '../domain/types'
import type { ModelCapabilityEntry } from './capabilities/modelCapability'

/**
 * The Jev routing port (issue #509; request v2, jev-routing-profiles T3):
 * asking TypeSafe's System One model to answer FIVE questions about a launch
 * prompt — is it trivial, does it need large context, which provider fits,
 * how capable a model, and how hard is the task — and the typed outcome
 * every launch path can act on without ever being blocked by it.
 *
 * The port hands back Jev's own RAW answers (`JevRouteAnswers`); mapping
 * them onto a concrete provider, model and effort through the profile and
 * the capability table is `routeDecision.ts`'s job, kept OUT of the port so
 * that mapping can be tested with no network at all.
 *
 * T3 lifted `JevFallbackReason` into `shared/contracts.ts` — a launch result
 * now carries that same vocabulary across the wire (`JevRouteLaunchResult`),
 * so the renderer can say WHY a launch fell back to the pickers' own values.
 * `JevRouteAnswers`, `JevRouteFallback` and `JevRouteOutcome` stay here, next
 * to the port that produces them: `JevRouteAnswers` carries
 * `usage.inputTokens`, which the wire result never may — see
 * `JevRouteLaunchResult`'s own comment in contracts.ts, which also carries
 * the full reasoning for the fallback vocabulary itself (why `route` can
 * never throw).
 */

/** Re-exported so every existing `import ... from './jevRouterPort'` keeps working unchanged. */
export type { JevFallbackReason }

/**
 * One Choice option's own description, in TypeSafe's OWN documented
 * vocabulary (docs.typesafe.ai) — snake_case is THEIR spelling, kept
 * verbatim rather than translated to camelCase, because this object is sent
 * to Jev exactly as built and Jev is calibrated on that exact shape.
 */
export interface JevChoiceCriteria {
  what: string
  not_for?: string
  examples: readonly [string, string]
}

/**
 * One built System One request, ready for a port implementation to send —
 * see routeRequest.ts's `buildJevRouteRequest`. Only the parts that vary per
 * CALL live here; the four fixed questions (`is_trivial`,
 * `needs_large_context`, `model_tier`, `effort`) are module-level constants
 * in routeRequest.ts that every implementation reads directly, the same way
 * `EFFORT_RUBRIC` already was before this request carried a `provider`
 * question too.
 */
export interface JevRouteRequest {
  /** The launch prompt — verbatim, or head+tail trimmed; see `truncated`. */
  prompt: string
  /** The profile Settings holds today. Rides on `state`, never on a question, so one request serves every profile and Jev conditions on it itself. */
  routingProfile: JevRoutingProfile
  /**
   * Whether `prompt` was shortened to fit TypeSafe's own token budget (see
   * routeRequest.ts). A launch may still want to say so, since a trimmed
   * prompt is not quite the one that was typed.
   */
  truncated: boolean
  /** The `provider` question's own criteria: one entry per launchable provider plus `no_preference`. */
  providerCriteria: Readonly<Record<string, JevChoiceCriteria>>
}

/**
 * Jev's own answer to all five questions — RAW, never yet resolved onto a
 * concrete provider, model or effort (`routeDecision.ts`'s `decideLaunch`
 * does that). `provider.choice`/`tier.choice` are exactly one of the keys
 * this app sent (`providerCriteria`'s own keys for `provider`;
 * `TIER_CHOICE_KEYS` in routeRequest.ts for `tier`) — never trusted further
 * than that by anything downstream, the same discipline the old single
 * model-choice answer held.
 */
export interface JevRouteAnswers {
  kind: 'answers'
  provider: { choice: string; confidence: number }
  tier: { choice: string; confidence: number }
  /** The `is_trivial` Noul's own probability of "yes" — never a confidence, see NoulResponse. */
  trivial: { probability: number }
  /** The `needs_large_context` Noul's own probability of "yes". */
  largeContext: { probability: number }
  effort: { score: number }
  usage: { inputTokens: number }
}

/**
 * Jev could not be asked, or its answer could not be acted on. Every member
 * is a real, named way this can happen — never a generic "failed" — so a
 * launch can say honestly why the pickers' own values were used instead.
 */
export interface JevRouteFallback {
  kind: 'fallback'
  reason: JevFallbackReason
  /**
   * Kept only for `'low-confidence'`, so a launch can show what Jev actually
   * reported alongside why it was not acted on. No path in this pipeline
   * produces `'low-confidence'` today: every per-question floor now resolves
   * to a safe default instead of a full fallback (jev-routing-profiles,
   * orchestrator decision 2026-09-21) — the member stays in the closed union
   * for the day a distinguishable low-confidence failure is worth naming
   * again, and so the renderer's existing exhaustive copy keeps compiling.
   */
  confidence?: number
}

export type JevRouteOutcome = JevRouteAnswers | JevRouteFallback

/* --- #608: the second request, over the tier's own candidate models ------- */

/**
 * One candidate's own capability facts, in the same shape a Choice option's
 * criteria already takes (`JevChoiceCriteria`), plus the facts beyond
 * `what`/`notFor`/`examples` that tell two same-tier candidates apart —
 * `tier`, `relativeCost` and `contextWindowTokens`, straight off
 * `ModelCapabilityEntry` (see `routeRequest.ts`'s `candidateCapabilityFacts`).
 * Never the model's own id, name or family — see this module's own top
 * comment and the jev-capabilities skill's evidence rule.
 */
export interface JevModelCandidateCriteria extends JevChoiceCriteria {
  tier: ModelTier
  relativeCost: ModelCapabilityEntry['relativeCost']
  contextWindowTokens?: number
}

/**
 * #608's second System One request: one Noul per candidate ("does this
 * model fit the prompt, given the tier the task needs?") plus one Choice
 * over the same candidates, all keyed by INDEX — `'0'`, `'1'`, … — never by
 * the candidate's own model id, so nothing about a model's identity ever
 * reaches Jev twice over (see `routeRequest.ts`'s own `buildJevModelRouteRequest`).
 * Only ever built when there are two or more candidates — see this file's
 * own `buildJevModelRouteRequest` comment for the single-candidate skip.
 */
export interface JevModelRouteRequest {
  prompt: string
  routingProfile: JevRoutingProfile
  truncated: boolean
  /** The tier the task needs — read into the Noul question's own instructions, never used to filter `candidates` again (that already happened). */
  tier: ModelTier
  /** One entry per candidate, keyed by index. */
  candidates: Readonly<Record<string, JevModelCandidateCriteria>>
}

/**
 * Jev's own answer to the second request — RAW, never yet resolved onto a
 * winner (`routeDecision.ts`'s `selectModelWinner` does that): every
 * candidate's own Noul "does it fit" probability, keyed the same way as
 * `candidates` above, plus the tie-breaking Choice's own choice and full
 * probability distribution (needed to read the TIED candidates' own shares,
 * not just the winner's).
 */
export interface JevModelRouteAnswers {
  kind: 'answers'
  fits: Readonly<Record<string, number>>
  choice: { choice: string; probabilities: Readonly<Record<string, number>> }
  usage: { inputTokens: number }
}

export type JevModelRouteOutcome = JevModelRouteAnswers | JevRouteFallback

/* --- end of the #608 block ------------------------------------------------- */

/**
 * What a launch asks of Jev. One implementation talks to TypeSafe's SDK
 * (typesafeJevRouter.ts); a scripted one answers tests (fakeJevRouter.ts).
 */
export interface JevRouterPort {
  route(request: JevRouteRequest, options: { signal?: AbortSignal }): Promise<JevRouteOutcome>
  /** #608's second request — see `JevModelRouteRequest`'s own comment. */
  routeModel(
    request: JevModelRouteRequest,
    options: { signal?: AbortSignal }
  ): Promise<JevModelRouteOutcome>
}
