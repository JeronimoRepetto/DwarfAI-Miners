/*
 * "Reset preset" wired to the Valle window (07 machine 37; US-VALLE-010; UC-062; 14 §2.2 A-N21, §3.9 `valleLayout`;
 * ADR-024 items 1, 4; BR-23; ISSUE-309): the reset machine (`resetPreset.ts`) stepped on each input, and every effect
 * carried out through the one owner of what it touches.
 *
 * - The layouts go through machine 28's one writer of `valleLayout` (`useVallePreset.resetLayouts`): the preset shown at
 *   its defaults, the other copied as it was, written at once. Pins are another key (`pins`) and never part of it; the
 *   mosaic order is the mosaic's (`useValleMosaic.resetPreset`, S32.15); the split is machine 30's (S30.11) and the
 *   chat width machine 33's (S33.10).
 * - The FLIP (S37.03, S37.04): the zones' content, the chat zone and the splitter are measured where they stand, the
 *   defaults applied, and once rendered each part plays from where it was, `transform` alone (`DS` `DM.motion.flip`,
 *   `--dur-panel`). The run ends on the first of its duration, its watchdog, or the first frame under reduced motion
 *   (S37.05, NFR-TIM-16). A failed layout write ends it at once with the defaults still applied for the session (S37.06);
 *   UI main's store logs `uiprefs.write-failed` itself (19 §9.6), so nothing is logged here.
 * - The toast goes through the window's one toast queue (BR-23), where the general toast rule puts it.
 *
 * The motion (clock, geometry, animation runner) is injected; the Valle root hands the browser's.
 */
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  type ComputedRef,
  type Ref
} from 'vue'
import {
  cornerFrames,
  startValleRun,
  VALLE_MOTION,
  type ValleAnimationTiming,
  type ValleBox,
  type ValleClock,
  type ValleFrames,
  type ValleRun
} from '../lib/valle/flip'
import type { ValleLayouts, ValleView } from '../lib/valle/preset'
import {
  stepResetPreset,
  type ResetPresetEffect,
  type ResetPresetInput,
  type ResetPresetState
} from '../lib/valle/resetPreset'

/** How the reset plays: its clock, reduced motion, the parts it moves, and how they are measured and animated. */
export interface ValleResetMotion {
  clock: ValleClock
  reduced(): boolean
  /** The zones' content the reset FLIPs: the zones, the chat zone and the splitter. */
  targets(): readonly Element[]
  box(element: Element): ValleBox
  animate(element: Element, frames: ValleFrames, timing: ValleAnimationTiming): void
  /** Runs once the defaults are rendered. */
  afterRender(run: () => void): void
}

export interface ValleResetPresetDeps {
  /** Machine 28's view: the preset shown, both layouts and the run in progress. */
  view(): Pick<ValleView, 'preset' | 'layouts' | 'motion'>
  /** Applies both layouts and writes them at once (A-N21); answers whether UI main took the write. */
  resetLayouts(layouts: ValleLayouts): Promise<boolean>
  /** S32.15: the Control room's mosaic recomputed. */
  recomputeMosaic(): void
  /** S30.11: the Work front's split turned off. */
  splitOff(): void
  /** S33.10: the splitter returns to rest at the default width. */
  splitterRest(): void
  /** The window's one toast queue (BR-23). */
  showToast(text: string): void
  /** The FLIP's motion; without it, the run settles at once. */
  motion?: ValleResetMotion
}

export interface ValleResetPresetPart {
  state: Readonly<Ref<ResetPresetState>>
  /** The "⋯" menu is open. */
  menuOpen: ComputedRef<boolean>
  /** "Reset preset" is offered: not while a dive or a climb plays (S37.01). */
  offered: ComputedRef<boolean>
  /** The top bar's "⋯": opens the menu, or closes it when it is open (S37.01, S37.02). */
  toggle(): void
  /** Esc or an outside press (S37.02); answers whether a menu was open. */
  dismiss(): boolean
  /** "Reset preset" picked (S37.03, S37.04); answers whether it was taken. */
  reset(): boolean
}

export function useValleResetPreset(deps: ValleResetPresetDeps): ValleResetPresetPart {
  const state = shallowRef<ResetPresetState>('idle')
  let run: ValleRun | null = null

  const moving = (): boolean => {
    const kind = deps.view().motion?.kind
    return kind === 'diving' || kind === 'climbing'
  }

  /** S37.03, S37.04: measured now, played once the defaults are rendered. */
  function flip(): boolean {
    const motion = deps.motion
    if (motion === undefined) return false
    const reduced = motion.reduced()
    const ms = reduced ? 0 : VALLE_MOTION.swap
    if (!reduced) {
      const parts = motion.targets().map((element) => ({ element, first: motion.box(element) }))
      motion.afterRender(() => {
        for (const { element, first } of parts) {
          // A zone the reset removed (a column the recomputed mosaic no longer holds) has nothing to play.
          if (!element.isConnected) continue
          const last = motion.box(element)
          if (first.left === last.left && first.top === last.top) continue
          motion.animate(element, cornerFrames(first, last), {
            duration: ms,
            easing: VALLE_MOTION.easeOut,
            fill: 'backwards'
          })
        }
      })
    }
    run = startValleRun(motion.clock, ms, () => {
      run = null
      send({ kind: 'settled' })
    })
    return true
  }

  function carry(effect: ResetPresetEffect): boolean {
    switch (effect.kind) {
      case 'flip':
        return !flip()
      case 'layouts':
        void deps.resetLayouts(effect.layouts).then((taken) => {
          if (!taken) send({ kind: 'write-failed' })
        })
        return false
      case 'splitter':
        deps.splitterRest()
        return false
      case 'mosaic':
        deps.recomputeMosaic()
        return false
      case 'split-off':
        deps.splitOff()
        return false
      case 'toast':
        deps.showToast(effect.text)
        return false
    }
  }

  function send(input: ResetPresetInput): boolean {
    const { preset, layouts } = deps.view()
    const step = stepResetPreset(state.value, input, { preset, layouts, moving: moving() })
    if (!step.ok) return false
    if (state.value === 'resetting' && step.state !== 'resetting') {
      run?.stop()
      run = null
    }
    state.value = step.state
    // Without a motion the run has nothing to wait for: it settles once the defaults are applied.
    const settleAtOnce = step.effects.map(carry).some(Boolean)
    if (settleAtOnce) send({ kind: 'settled' })
    return true
  }

  if (getCurrentScope() !== undefined) onScopeDispose(() => run?.stop())

  return {
    state,
    menuOpen: computed(() => state.value === 'menu-open'),
    offered: computed(() => !moving()),
    toggle() {
      send({ kind: state.value === 'menu-open' ? 'dismiss' : 'menu' })
    },
    dismiss: () => state.value === 'menu-open' && send({ kind: 'dismiss' }),
    reset: () => send({ kind: 'reset' })
  }
}
