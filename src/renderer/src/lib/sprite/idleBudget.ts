/**
 * The idle budget: what an idle scene may spend on motion (NFR-PERF-04; ADR-025 item 7; 07
 * machine 20 `no-sessions`; ISSUE-283).
 *
 * An idle scene draws one slow loop of a few frames, played by the browser from CSS keyframes
 * (`cssLoop`), and nothing else moves: no second loop, and no sprite on the frame clock, since a
 * sprite on the clock is a JavaScript timer waking the renderer. A scene composed for an idle state
 * (Veta's "No sessions", ISSUE-287) describes what it runs, and this pure check refuses a
 * description that breaks the budget, saying why.
 *
 * It sets no CPU number: the measured ceiling comes from the per-OS recordings (`17` §1.11).
 */
import { isCssLoop, type LoopSpec } from './cssLoop'

/** What an idle scene runs: its loops, and how many sprites it subscribes to the frame clock. */
export interface IdleScene {
  readonly loops: readonly LoopSpec[]
  readonly clockSubscriptions: number
}

/** Why a scene is refused. */
export type IdleBudgetBreach =
  /** Nothing at all: the scene has lost its one loop. */
  | 'no-loop'
  /** More than one loop runs. */
  | 'second-loop'
  /** A loop that `cssLoop` did not build, so nothing says it is timer-free and transform-only. */
  | 'not-a-css-loop'
  /** A sprite is on the frame clock. */
  | 'clock-subscription'

export type IdleBudgetVerdict =
  { readonly ok: true } | { readonly ok: false; readonly breaches: readonly IdleBudgetBreach[] }

/** Checks a scene description against the idle budget. */
export function checkIdleBudget(scene: IdleScene): IdleBudgetVerdict {
  const breaches: IdleBudgetBreach[] = []
  if (scene.loops.length === 0) breaches.push('no-loop')
  if (scene.loops.length > 1) breaches.push('second-loop')
  if (!scene.loops.every(isCssLoop)) breaches.push('not-a-css-loop')
  if (scene.clockSubscriptions !== 0) breaches.push('clock-subscription')
  return breaches.length === 0 ? { ok: true } : { ok: false, breaches }
}
