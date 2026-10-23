import type { UiSessionPatch } from '@dwarfai/contracts'
import { shallowRef, type ShallowRef } from 'vue'
import { startValleRun, type ValleClock, type ValleRun } from '../lib/valle/flip'
import {
  HISTORY_DRAWER_START,
  historyDrawerMotion,
  historyDrawerPatch,
  stepHistoryDrawer,
  type HistoryDrawerEffect,
  type HistoryDrawerInput,
  type HistoryDrawerState
} from '../lib/valle/historyDrawer'

/*
 * The Work front's history drawer in the Valle window (07 machine 36; US-VALLE-011; UC-061; ISSUE-308).
 *
 * - Its state lives here, for this window's run: it starts closed and is never stored (S36.07; ADR-024 item 1); each
 *   open and close is written through A-N18 `valle.historyOpen`.
 * - The rise and the sink play on the drawer alone, through the window's bounded runner, `transform` and `opacity` only;
 *   the run that ends them reads the injected frame clock with its watchdog (`startValleRun`), so a motion that never
 *   reports its end still settles (S36.02, NFR-TIM-16). Under reduced motion each run lasts 0 ms.
 * - A close at once (S36.04, S36.06) ends any run and any motion on the drawer, and plays nothing.
 */

export interface ValleHistoryDrawerMotion {
  clock: ValleClock
  reduced: () => boolean
  /** The drawer's element once drawn, or `null`. */
  target: () => Element | null
  animate: (
    element: Element,
    frames: readonly Keyframe[],
    timing: { duration: number; easing: string; fill: FillMode }
  ) => void
  /** Ends the motion on these elements at once. */
  cancel: (elements: readonly Element[]) => void
  /** Runs after the next render, once the drawer is drawn. */
  afterRender: (run: () => void) => void
}

export interface ValleHistoryDrawerDeps {
  /** A-N18 (`patchUiSession`). */
  bridge: { patchUiSession(patch: UiSessionPatch): void }
  motion: ValleHistoryDrawerMotion
}

export interface ValleHistoryDrawerPart {
  state: Readonly<ShallowRef<HistoryDrawerState>>
  /** An input of machine 36; answers whether a listed transition was taken. */
  send(input: HistoryDrawerInput): boolean
  stop(): void
}

export function useValleHistoryDrawer(deps: ValleHistoryDrawerDeps): ValleHistoryDrawerPart {
  const state = shallowRef<HistoryDrawerState>(HISTORY_DRAWER_START)
  let run: ValleRun | null = null

  function play(kind: 'rise' | 'sink', done: HistoryDrawerInput): void {
    run?.stop()
    const motion = historyDrawerMotion(kind, deps.motion.reduced())
    if (motion.duration > 0) {
      deps.motion.afterRender(() => {
        const element = deps.motion.target()
        if (element === null || state.value.kind !== (kind === 'rise' ? 'opening' : 'closing'))
          return
        deps.motion.animate(element, motion.frames, {
          duration: motion.duration,
          easing: motion.easing,
          fill: motion.fill
        })
      })
    }
    run = startValleRun(deps.motion.clock, motion.duration, () => {
      run = null
      send(done)
    })
  }

  function apply(effect: HistoryDrawerEffect, drawn: Element | null): void {
    switch (effect.kind) {
      case 'rise':
        play('rise', { kind: 'risen' })
        return
      case 'sink':
        play('sink', { kind: 'sunk' })
        return
      case 'stop-motion':
        run?.stop()
        run = null
        if (drawn !== null) deps.motion.cancel([drawn])
        return
      case 'write-session':
        deps.bridge.patchUiSession(historyDrawerPatch(effect.open))
        return
    }
  }

  function send(input: HistoryDrawerInput): boolean {
    const step = stepHistoryDrawer(state.value, input)
    if (!step.ok) return false
    // The element drawn before the step: a close at once removes it, and its motion goes with it.
    const drawn = deps.motion.target()
    state.value = step.state
    for (const effect of step.effects) apply(effect, drawn)
    return true
  }

  return {
    state,
    send,
    stop() {
      run?.stop()
      run = null
    }
  }
}
