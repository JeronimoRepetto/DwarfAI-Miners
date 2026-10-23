/*
 * A stand-in host for the pin stack and the deck in component tests (ISSUE-302; 17 §2.2): it steps 07 machine 29 on
 * each event the component emits and hands the new set back, as the Valle root does. Never imported by production code
 * (R14).
 */
import type { DwarfId, DwarfStatus, MineId } from '@dwarfai/contracts'
import { defineComponent, h, shallowRef, type Component } from 'vue'
import {
  pinViews,
  stepPins,
  type FocusRequest,
  type PinInput,
  type PinKey,
  type PinSet,
  type PinTextFacts
} from '../pins'

/** Facts for `pinText`: each dwarf's name, status and open ask, and each mine's name. */
export function pinFacts(
  dwarfs: Record<string, { name: string; status?: DwarfStatus; ask?: 'permission' | 'question' }>,
  mines: Record<string, string> = {}
): PinTextFacts {
  return {
    dwarf: (dwarfId: DwarfId) => {
      const dwarf = dwarfs[dwarfId]
      return dwarf === undefined
        ? null
        : { name: dwarf.name, status: dwarf.status ?? 'idle', ask: dwarf.ask ?? null }
    },
    mineName: (mineId: MineId) => mines[mineId] ?? null
  }
}

/** Mounts `component` over a pin set that machine 29 steps on each emitted event. */
export function pinHarness(
  component: Component,
  initial: PinSet,
  facts: PinTextFacts,
  /** More props for the component, read on each render from the current set (a deck's `split`). */
  extra: (set: PinSet) => Record<string, unknown> = () => ({})
) {
  const set = shallowRef(initial)
  const request = shallowRef<FocusRequest | null>(null)
  const sent: PinInput[] = []
  let seq = 0
  function send(input: PinInput): void {
    sent.push(input)
    const step = stepPins(set.value, input)
    if (!step.ok) return
    set.value = step.set
    for (const effect of step.effects) {
      if (effect.kind === 'keyboard-focus')
        request.value = { target: effect.target, seq: (seq += 1) }
    }
  }
  const Harness = defineComponent({
    setup: () => () =>
      h(component, {
        ...extra(set.value),
        pins: pinViews(set.value, facts),
        focus: set.value.focus,
        focusRequest: request.value,
        onSelect: (key: PinKey) => send({ kind: 'select', key }),
        onUnpin: (key: PinKey) => send({ kind: 'unpin', key }),
        onDrag: (key: PinKey) => send({ kind: 'drag', key }),
        onDrop: (order: readonly PinKey[]) => send({ kind: 'drop', order }),
        onDragCancel: () => send({ kind: 'drag-cancel' })
      })
  })
  return { Harness, set, sent, send }
}
