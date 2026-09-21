import type { DwarfProvider, JevFallbackReason } from '../domain/types'

/**
 * The Jev routing port (issue #509): asking TypeSafe's System One model to
 * pick a provider, model and effort from a launch prompt, and the typed
 * outcome every launch path can act on without ever being blocked by it.
 *
 * T3 lifted `JevFallbackReason` into `shared/contracts.ts` — a launch result
 * now carries that same vocabulary across the wire (`JevRouteLaunchResult`),
 * so the renderer can say WHY a launch fell back to the pickers' own values.
 * `JevRouteDecision`, `JevRouteFallback` and `JevRouteOutcome` stay here,
 * next to the port that produces them: they carry `usage.inputTokens`, which
 * the wire result never may — see `JevRouteLaunchResult`'s own comment in
 * contracts.ts, which also carries the full reasoning for the fallback
 * vocabulary itself (why `route` can never throw).
 */

/** Re-exported so every existing `import ... from './jevRouterPort'` keeps working unchanged. */
export type { JevFallbackReason }

/**
 * One option the model question may answer — see routeRequest.ts's
 * `buildJevRouteRequest`: a provider paired with one of its own models, or a
 * provider alone when it has none to offer.
 *
 * `key` is what travels to Jev and what its `choice` answer names back:
 * `<provider>:<model>`, with the model half left EMPTY rather than the key
 * being just the bare provider name — so every key has the same shape, and a
 * provider's own name can never collide with another provider's model value
 * happening to equal it.
 */
export interface JevModelChoice {
  key: string
  provider: DwarfProvider
  /** Absent for the "let the CLI pick" option — see `key`'s own comment. */
  model?: string
  /** The one-line sentence Jev sees for this option. */
  criteria: string
}

/** One built System One request, ready for a port implementation to send. */
export interface JevRouteRequest {
  /** The launch prompt — verbatim, or head+tail trimmed; see `truncated`. */
  state: string
  /**
   * Whether `state` was shortened to fit TypeSafe's own token budget (see
   * routeRequest.ts). A launch may still want to say so, since a trimmed
   * prompt is not quite the one that was typed.
   */
  truncated: boolean
  /** Every option the model question may answer. */
  modelChoices: readonly JevModelChoice[]
}

/**
 * Jev chose. `model` and `effort` are each absent on the same terms
 * `LaunchTuning` already reads absence as (see launchTuning.ts's own module
 * comment): the CLI keeps its own default for whichever half Jev did not, or
 * could not, name.
 */
export interface JevRouteDecision {
  kind: 'decision'
  provider: DwarfProvider
  model?: string
  effort?: string
  /** The model question's own reported confidence — see JEV_MIN_CONFIDENCE. */
  confidence: number
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
   * The decision's own confidence, kept only for `'low-confidence'` so a
   * launch can show what Jev actually reported alongside why it was not
   * acted on. Absent for every other reason, which never got far enough to
   * have one.
   */
  confidence?: number
}

export type JevRouteOutcome = JevRouteDecision | JevRouteFallback

/**
 * What a launch asks of Jev. One implementation talks to TypeSafe's SDK
 * (typesafeJevRouter.ts); a scripted one answers tests (fakeJevRouter.ts).
 */
export interface JevRouterPort {
  route(request: JevRouteRequest, options: { signal?: AbortSignal }): Promise<JevRouteOutcome>
}
