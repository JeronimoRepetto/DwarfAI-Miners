/*
 * Valle's needs-you counter and queue (07 machine 34; UC-059; US-VALLE-004, US-VALLE-012; ISSUE-306): the top bar's
 * "Need you ▸" counter and the footer's row, read from the Host's `NeedsYouQueue` the Valle read model holds (the
 * snapshot's `asks` section, patched in place by its frames; ADR-033 item 3: never derived here), and the jump a press
 * makes in the preset shown, which it never changes.
 *
 * - The words are `needsYou.ts`'s; the entries follow the queue's order, one per waiting dwarf, so the row's keyed
 *   entries patch in place: a new asker appends, a cleared one closes the gap, the others neither move nor redraw
 *   (NFR-PERF-03). Both presets read the same queue (S34.09). No timer and no polling: the read model's frames alone.
 * - A press steps machine 34 and carries the jump through the composables that own each part, one writer per key:
 *   in the Control room the mine's column is added and scrolled to (S32.14, the mosaic), the dwarf's chat pinned and
 *   focused, expanded in the stack (S29.19, the pins), its mine made current (S35.01), and its zone called with the
 *   ring; in the Work front a swap to the dwarf's mine when it differs (S28.15, no dive), then its tab selected (S29.19).
 *   The pins mark the chat as answered from the queue for a later dive (S28.03).
 * - Owner ruling 2026-10-23 (VQA-02, VQA-13; `DS` valle.js `nextNeed`, `answer`): the counter goes to the next waiter
 *   after the one it last jumped to, round the queue, the ones that left skipped; every jump, the counter's or an
 *   entry's, ends with the keyboard in that dwarf's chat.
 * - A stale press (S34.11): the entry's ask closed before the press ran; its chat still opens while the dwarf is present.
 *
 * The jump's parts are injected; the Valle root hands it its own composables.
 */
import type { DwarfId, DwarfWire, MineId, MineWire } from '@dwarfai/contracts'
import { computed, shallowRef, type Ref } from 'vue'
import {
  counterView,
  entryView,
  stepNeedsYou,
  type CounterView,
  type EntryView,
  type JumpTarget,
  type NeedsYouEntry,
  type NeedsYouInput,
  type NeedsYouQueue
} from '../lib/valle/needsYou'
import type { VallePreset } from '../lib/valle/preset'

/** What the counter and the row read of the Valle read model. */
export interface ValleNeedsYouModel {
  /** The Host's needs-you queue, in its order. */
  needsYou: Readonly<Ref<NeedsYouQueue>>
  dwarfs: Readonly<Ref<readonly DwarfWire[]>>
  mines: Readonly<Ref<readonly MineWire[]>>
  askOf(dwarfId: DwarfId): 'question' | 'permission' | null
}

/** The parts of a jump, each through the composable that owns it. */
export interface ValleNeedsYouJump {
  /** S32.14: the mine's column added when absent, and scrolled to (the mosaic). */
  reveal(mineId: MineId): void
  /** S29.19: the dwarf's chat pinned when absent, then focused (the pins). */
  pin(dwarfId: DwarfId, mineId: MineId): void
  /** S35.01: the mine made current (the current mine). */
  current(mineId: MineId): void
  /** S28.15: the Work front swapped to the mine, the tab order led by the dwarf (the preset's own swap). */
  swap(mineId: MineId, dwarfId: DwarfId): void
  /**
   * Owner ruling 2026-10-23 (VQA-13; `DS` valle.js `answer`): the keyboard handed to the dwarf's chat once the jump
   * drew it, instead of staying on the counter or the entry pressed.
   */
  focus?(dwarfId: DwarfId): void
}

export interface ValleNeedsYouDeps {
  model: ValleNeedsYouModel
  /** The preset shown, read only. */
  preset(): VallePreset
  /** The Work front's mine. */
  frontMine(): MineId | null
  jump: ValleNeedsYouJump
}

/** The mine whose zone a jump called with the ring, and the jump's number, which restarts its flash. */
export interface ValleCall {
  readonly mineId: MineId
  readonly seq: number
}

export interface ValleNeedsYouPart {
  counter: Readonly<Ref<CounterView>>
  /** The row's entries, oldest first, in the Host's order. */
  entries: Readonly<Ref<readonly EntryView[]>>
  /** The zone the last Control room jump called, while its mine still has someone waiting. */
  called: Readonly<Ref<ValleCall | null>>
  /** The counter pressed (S34.05, S34.06, S34.08). */
  press(): void
  /** An entry pressed, as the row drew it (S34.07, S34.11). */
  pressEntry(entry: { readonly dwarfId: DwarfId; readonly mineId: MineId }): void
}

export function useValleNeedsYou(deps: ValleNeedsYouDeps): ValleNeedsYouPart {
  const { model } = deps
  const lastCall = shallowRef<ValleCall | null>(null)
  let seq = 0

  const dwarfOf = (dwarfId: DwarfId): DwarfWire | undefined =>
    model.dwarfs.value.find((dwarf) => dwarf.id === dwarfId)

  const counter = computed(() => counterView(model.needsYou.value))
  const entries = computed(() =>
    model.needsYou.value.map((entry) =>
      entryView(entry, {
        name: (dwarfId) => {
          const dwarf = dwarfOf(dwarfId)
          return dwarf === undefined ? '' : (dwarf.customName ?? dwarf.baseName)
        },
        mineName: (mineId) => model.mines.value.find((mine) => mine.id === mineId)?.name ?? '',
        askOf: (dwarfId) => model.askOf(dwarfId)
      })
    )
  )
  const called = computed(() => {
    const call = lastCall.value
    if (call === null) return null
    return model.needsYou.value.some((entry) => entry.mineId === call.mineId) ? call : null
  })

  /**
   * The entry the last jump went to, as it was then (owner ruling 2026-10-23, VQA-02): the counter's next press goes to
   * the one after it, round the queue (`nextWaiter`). Kept even once that dwarf left the queue, so the ones that left
   * are skipped rather than the turn starting over.
   */
  let lastJumped: NeedsYouEntry | null = null

  function carry(jump: JumpTarget): void {
    if (jump.preset === 'control') {
      deps.jump.reveal(jump.mineId)
      deps.jump.pin(jump.dwarfId, jump.mineId)
      deps.jump.current(jump.mineId)
      lastCall.value = { mineId: jump.mineId, seq: (seq += 1) }
    } else {
      if (jump.swap) deps.jump.swap(jump.mineId, jump.dwarfId)
      deps.jump.pin(jump.dwarfId, jump.mineId)
    }
    lastJumped = model.needsYou.value.find((entry) => entry.dwarfId === jump.dwarfId) ?? lastJumped
    deps.jump.focus?.(jump.dwarfId)
  }

  function send(input: NeedsYouInput): void {
    const step = stepNeedsYou(model.needsYou.value, input)
    if (step.ok && step.jump !== null) carry(step.jump)
  }

  return {
    counter,
    entries,
    called,
    press() {
      send({
        kind: 'counter',
        preset: deps.preset(),
        frontMine: deps.frontMine(),
        after: lastJumped
      })
    },
    pressEntry(entry) {
      send({
        kind: 'entry',
        dwarfId: entry.dwarfId,
        mineId: entry.mineId,
        preset: deps.preset(),
        frontMine: deps.frontMine(),
        present: dwarfOf(entry.dwarfId) !== undefined
      })
    }
  }
}
