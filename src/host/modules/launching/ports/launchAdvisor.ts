// Driven port of launching (05 §3.5, 16 §4.5 `LaunchAdvisor`): the bridge → jev that asks Jev for a
// normal launch's pick (`JevAdvisor.suggest({ purpose: 'launch' })`). The bridge lives in
// `host/wiring` (later: ISSUE-182). Type-only (R2).
//
// - 16 §6.4: the errors are the two Jev launch causes; the bridge reports `JevAdvisor`'s
//   `not-configured` as the `no-key` fallback (16 §13 O-16-06), and a reason it knows as the
//   suggestion's `fallback` (06 §12 `JevSuggestion.fallback`), so the launch can name it.
// - The `effort-ceiling` fallback on a launch is **not** an error: the suggestion carries the
//   configured default and the launch ends `handed-back` (ADR-028 D2, OQ-38 B); with no default it
//   carries no provider and the launch fails `jev-could-not-choose`.
// - 16 §6.5: 8 000 ms per Jev attempt; the advisor passes an `AbortSignal`, which launching fires
//   when the routing budget ran out (application/launch.ts).
import type { MineId, Result } from '../../../kernel/domain/values'
import type { JevSuggestionView } from '../../jev'

// As 05 §3.5 writes it (16 §4.5; layout by prettier).
export interface LaunchAdvisor {
  suggest(
    prompt: string,
    mineId: MineId
  ): Promise<Result<JevSuggestionView, 'jev-unreachable' | 'jev-could-not-choose'>>
}

/** 16 §6.5: the signal launching fires when it stops waiting for Jev. */
export interface LaunchAdviceOptions {
  signal?: AbortSignal
}

/**
 * The advisor launching is composed with: the 05 §3.5 port, whose `suggest` also takes the abort
 * signal 16 §6.5 says is passed (an extra optional argument, so it is still a `LaunchAdvisor`; the
 * same shape as jev's `AbortableJevAdvisor`).
 */
export interface AbortableLaunchAdvisor extends LaunchAdvisor {
  suggest(
    prompt: string,
    mineId: MineId,
    opts?: LaunchAdviceOptions
  ): Promise<Result<JevSuggestionView, 'jev-unreachable' | 'jev-could-not-choose'>>
}
