/*
 * Valle's preset in use (07 machine 28; 14 §2.2 A-N20, A-N21, A-N13; ADR-024 items 1, 4, 8, 9; ISSUE-300): the view
 * Valle shows, opened from the stores read before its first paint (S28.01, S28.02), stepped through machine 28 on each
 * input, and every change written at once through A-N21 (`vallePreset`, `valleLayout`), UI main the only writer of the
 * stores (S28.26). "▼ Panel" and "▼ Veta" move through A-N13 with the chat in focus (S28.21). After Reset metrics the
 * stores read again open the Control room on its defaults (S28.25, S39.10).
 *
 * The bridge is injected (the house idiom over `vi.mock`); the Valle root hands it the page's own `window.api`.
 */
import type { MoveToModeParams, UiPreferenceWrite } from '@dwarfai/contracts'
import { shallowRef, watch, type Ref } from 'vue'
import {
  stepValle,
  type ValleEffect,
  type ValleFacts,
  type ValleInput,
  type ValleView
} from '../lib/valle/preset'
import { restoreValleView } from '../lib/valle/restore'
import type { ValleStores } from './useValleStores'

/** The seam A members the preset uses (14 A-N21, A-N13). */
export interface VallePresetBridge {
  setUiPreference(
    write: Extract<UiPreferenceWrite, { key: 'vallePreset' | 'valleLayout' }>
  ): Promise<unknown>
  moveToMode(params: MoveToModeParams): Promise<unknown>
}

export interface VallePresetDeps {
  bridge: VallePresetBridge
  /** The stores read before the first paint, read again after Reset metrics (`useValleStores`). */
  stores: Readonly<Ref<ValleStores>>
  /** What machine 28's guards read now. */
  facts(): ValleFacts
}

export interface VallePresetPart {
  view: Readonly<Ref<ValleView>>
  /** Steps machine 28; answers whether the input was taken. */
  send(input: ValleInput): boolean
  /** Machine 30's wish, the Work front layout's `split` (07 N-17), written at once with that layout (A-N21). */
  wishSplit(split: boolean): void
}

const opened = (stores: ValleStores): ValleView =>
  restoreValleView({ preset: stores.preset, layout: stores.layout })

export function useVallePreset(deps: VallePresetDeps): VallePresetPart {
  const view = shallowRef<ValleView>(opened(deps.stores.value))
  watch(
    () => deps.stores.value,
    (stores) => {
      view.value = opened(stores)
    }
  )
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
      case 'move':
        void deps.bridge.moveToMode(effect.move).catch(ignore)
        return
      case 'reclamp':
        // The chat zone's clamp is the splitter's (ISSUE-305); the split re-checks on the body's own
        // resize (useValleSplit, ISSUE-303).
        return
    }
  }
  return {
    view,
    send(input) {
      const step = stepValle(view.value, input, deps.facts())
      if (!step.ok) return false
      view.value = step.view
      step.effects.forEach(carry)
      return true
    },
    wishSplit(split) {
      const current = view.value
      if (current.layouts.front.split === split) return
      const layouts = { ...current.layouts, front: { ...current.layouts.front, split } }
      view.value = { ...current, layouts }
      carry({ kind: 'write-layouts', layouts })
    }
  }
}
