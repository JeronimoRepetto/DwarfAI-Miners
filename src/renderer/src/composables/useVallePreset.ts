/*
 * Valle's preset in use (07 machine 28; 14 §2.2 A-N20, A-N21, A-N18, A-N13; ADR-024 items 1, 4, 8, 9; ISSUE-300,
 * ISSUE-301): the view Valle shows, opened from the stores read before its first paint (S28.01, S28.02), stepped through
 * machine 28 on each input, and every change written at once through A-N21 (`vallePreset`, `valleLayout`,
 * `valleLastFrontMineId`), UI main the only writer of the stores (S28.26). "▼ Panel" and "▼ Veta" move through A-N13
 * with the chat in focus (S28.21). After Reset metrics the stores read again open the Control room on its defaults
 * (S28.25, S39.10).
 *
 * - A dive, a climb or a swap (ISSUE-301): the stage plays it (`flip.ts`) and the run ends on the first of its duration,
 *   its watchdog or the window going hidden (S28.22, NFR-TIM-16), when machine 28 settles. Input during a dive or a
 *   climb is ignored by the machine, never queued; a mode control is held and moves when the run settles (S28.09,
 *   S28.14). With no motion given, a run settles at once.
 * - The mosaic's scroll and the dwarf the dive is for go to the session through A-N18, never to a store (ADR-024 item
 *   4); the tab order is rebuilt and the split adjusted by `dived` (S29.12, S30.07).
 *
 * The bridge is injected (the house idiom over `vi.mock`); the Valle root hands it the page's own `window.api`.
 */
import type {
  DwarfId,
  MineId,
  MoveToModeParams,
  UiPreferenceWrite,
  UiSessionPatch
} from '@dwarfai/contracts'
import { getCurrentScope, onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import {
  startValleRun,
  valleRunMs,
  type ValleClock,
  type ValleRun,
  type ValleStageMotion
} from '../lib/valle/flip'
import {
  stepValle,
  type ValleEffect,
  type ValleFacts,
  type ValleInput,
  type ValleView
} from '../lib/valle/preset'
import { restoreValleView } from '../lib/valle/restore'
import type { ValleStores } from './useValleStores'

/**
 * The last mine worked in as A-N21 takes it from a renderer: a mine, never `null` (never written), which only Reset
 * metrics returns the store to (S39.10, UI main's own).
 */
export interface ValleLastMineWrite {
  key: 'valleLastFrontMineId'
  value: MineId
}

/** The seam A members the preset uses (14 A-N21, A-N18, A-N13). */
export interface VallePresetBridge {
  setUiPreference(
    write: Extract<UiPreferenceWrite, { key: 'vallePreset' | 'valleLayout' }> | ValleLastMineWrite
  ): Promise<unknown>
  patchUiSession(patch: UiSessionPatch): void
  moveToMode(params: MoveToModeParams): Promise<unknown>
}

/** How a run plays: its clock, reduced motion, and the stage that measures and animates the parts. */
export interface VallePresetMotion {
  clock: ValleClock
  reduced(): boolean
  stage: {
    play(motion: ValleStageMotion, scrollLeft: number): void
    restoreScroll(scrollLeft: number): void
    end(): void
  }
}

export interface VallePresetDeps {
  bridge: VallePresetBridge
  /** The stores read before the first paint, read again after Reset metrics (`useValleStores`). */
  stores: Readonly<Ref<ValleStores>>
  /** What machine 28's guards and actions read now. */
  facts(): ValleFacts
  /** A dive or a swap into `mineId`: the tab order rebuilt (S29.12) and the split adjusted (S30.07). */
  dived?(mineId: MineId, forDwarfId: DwarfId | null): void
  /** The motion; without it, every run settles at once. */
  motion?: VallePresetMotion
}

export interface VallePresetPart {
  view: Readonly<Ref<ValleView>>
  /** Steps machine 28; answers whether the input was taken. */
  send(input: ValleInput): boolean
  /** Machine 30's wish, the Work front layout's `split` (07 N-17), written at once with that layout (A-N21). */
  wishSplit(split: boolean): void
}

const opened = (stores: ValleStores): ValleView =>
  restoreValleView({
    preset: stores.preset,
    layout: stores.layout,
    lastFrontMineId: stores.lastFrontMineId,
    session: stores.session.valle
  })

export function useVallePreset(deps: VallePresetDeps): VallePresetPart {
  const view = shallowRef<ValleView>(opened(deps.stores.value))
  let run: ValleRun | null = null

  // A write or a move UI main refuses or cannot take leaves the view as it is: the window never fails for it.
  const ignore = (): void => {}
  function carry(effect: ValleEffect): void {
    switch (effect.kind) {
      case 'write-preset':
        void deps.bridge.setUiPreference({ key: 'vallePreset', value: effect.preset }).catch(ignore)
        return
      case 'write-layouts':
        void deps.bridge
          .setUiPreference({ key: 'valleLayout', value: effect.layouts })
          .catch(ignore)
        return
      case 'write-last-mine':
        void deps.bridge
          .setUiPreference({ key: 'valleLastFrontMineId', value: effect.mineId })
          .catch(ignore)
        return
      case 'session':
        deps.bridge.patchUiSession({ kind: 'valle', patch: effect.patch })
        return
      case 'dive-pins':
        deps.dived?.(effect.mineId, effect.forDwarfId)
        return
      case 'play':
        deps.motion?.stage.play(effect.motion, effect.scrollLeft)
        return
      case 'restore-scroll':
        deps.motion?.stage.restoreScroll(effect.scrollLeft)
        return
      case 'move':
        void deps.bridge.moveToMode(effect.move).catch(ignore)
        return
      case 'reclamp':
        // The chat zone's clamp is the splitter's (ISSUE-305); the split re-checks on the body's own
        // resize (useValleSplit, ISSUE-303).
        return
    }
  }

  /** The run ended, or was resolved by another route: the clock stops for it and the stage clears. */
  function ended(): void {
    run?.stop()
    run = null
    deps.motion?.stage.end()
  }

  function send(input: ValleInput): boolean {
    const before = view.value
    const step = stepValle(before, input, deps.facts())
    if (!step.ok) return false
    view.value = step.view
    if (before.motion !== undefined && step.view.motion === undefined) ended()
    step.effects.forEach(carry)
    const motion = step.view.motion
    if (motion !== undefined && before.motion === undefined) {
      const settle = (): boolean => send({ kind: 'settled' })
      if (deps.motion === undefined) settle()
      else {
        const ms = valleRunMs(motion.kind, deps.motion.reduced())
        run = startValleRun(deps.motion.clock, ms, () => {
          run = null
          settle()
        })
      }
    }
    return true
  }

  watch(
    () => deps.stores.value,
    (stores) => {
      if (run !== null) ended()
      view.value = opened(stores)
    }
  )
  if (getCurrentScope() !== undefined) onScopeDispose(() => run?.stop())

  return {
    view,
    send,
    wishSplit(split) {
      const current = view.value
      if (current.layouts.front.split === split) return
      const layouts = { ...current.layouts, front: { ...current.layouts.front, split } }
      view.value = { ...current, layouts }
      carry({ kind: 'write-layouts', layouts })
    }
  }
}
