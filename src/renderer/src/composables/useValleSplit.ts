/*
 * The Work front's split wired to the window (07 machine 30; UC-056; 14 §2.2 A-N18, A-N21, §3.9
 * `ValleLayoutFront.split`, `UiSessionSnapshot.valle.secondPaneDwarfId`; ADR-024 items 1, 4; NFR-PERF-09; ISSUE-303):
 * the split set (`split.ts`) restored once, stepped on each input, and every effect carried out.
 *
 * - The room is measured by one observer on Valle's body (`ResizeObserver`, its content width) and recomputed on its
 *   events, and on the Work front list folding or unfolding; never on a timer (NFR-PERF-09). A window, work-area or
 *   display resize all reach the body.
 * - S30.13: once the Host's facts were read (the pins open on them) and the body was measured, the persisted wish is
 *   re-evaluated against the room and the pins, the session's second pane kept while it is still pinned. Nothing is
 *   written by the restore.
 * - The pin set (machine 29) is watched: a shown pin unpinned, closed or dropped steps S30.10; its focus moving steps
 *   S30.08 or S30.09. A dive or a Work front swap sent through `sendPin` steps S30.07 (later: ISSUE-301 sends them).
 * - The wish is written with the Work front layout (A-N21, through the preset that owns that layout); the second pane's
 *   chat goes to the session (A-N18), never persisted.
 * - Reset metrics: the stores read again turn the split off (S30.12).
 *
 * The bridge and the observer are injected (the house idiom over `vi.mock`); the Valle root hands the page's own.
 */
import type { UiSessionPatch } from '@dwarfai/contracts'
import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import type { PinInput, PinKey, PinSet, PinView } from '../lib/valle/pins'
import {
  SPLIT_OFF,
  restoredSplit,
  splitButton,
  splitPanes,
  splitRoom,
  stepSplit,
  type SplitButton,
  type SplitEffect,
  type SplitFacts,
  type SplitInput,
  type SplitSet
} from '../lib/valle/split'
import type { ValleStores } from './useValleStores'

/** The seam A member the split uses (14 A-N18); the wish goes through the preset's own A-N21 write. */
export interface ValleSplitBridge {
  patchUiSession(patch: UiSessionPatch): void
}

/** Observes `target`'s content width, calling back on each change (and once when observing starts); answers a stop. */
export type ValleBodyObserver = (target: Element, callback: (width: number) => void) => () => void

/** The browser's own `ResizeObserver` on the body's content box. */
export const browserBodyObserver: ValleBodyObserver = (target, callback) => {
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1]
    if (entry !== undefined) callback(entry.contentRect.width)
  })
  observer.observe(target)
  return () => observer.disconnect()
}

export interface ValleSplitDeps {
  bridge: ValleSplitBridge
  /** The pin set (machine 29, `useVallePins`). */
  pins: {
    set: Readonly<Ref<PinSet>>
    views: Readonly<Ref<readonly PinView[]>>
    send(input: PinInput): boolean
  }
  /** The stores read before the first paint, read again after Reset metrics (`useValleStores`). */
  stores: Readonly<Ref<ValleStores>>
  /** The Host's facts were read once: the pins are open. */
  factsRead: Readonly<Ref<boolean>>
  /** Valle's body, whose width the room is measured from. */
  body: Readonly<Ref<HTMLElement | null>>
  /** The persisted wish (`valleLayout.front.split`). */
  wish(): boolean
  /** Writes the wish with the Work front layout (A-N21). */
  writeWish(split: boolean): void
  /** The Work front's compact list is folded (44 px instead of 232). */
  foldedList(): boolean
  /** The portraits of the Work front's mine. */
  portraits(): number
  observe: ValleBodyObserver
}

export interface ValleSplitPart {
  set: Readonly<Ref<SplitSet>>
  /** The panes shown, first then second. */
  panes: Readonly<Ref<readonly PinKey[]>>
  /** "⫽": enabled or not, pressed, its title. */
  button: Readonly<Ref<SplitButton>>
  /** "⫽" pressed. */
  press(): void
  /** A pin input for machine 29; a dive keeps the first pane's chat for S30.07. */
  sendPin(input: PinInput): boolean
  /** Steps machine 30 directly ("Reset preset", S30.11); answers whether the input was taken. */
  send(input: SplitInput): boolean
}

export function useValleSplit(deps: ValleSplitDeps): ValleSplitPart {
  const set = shallowRef<SplitSet>(SPLIT_OFF)
  /** The body's content width, once measured. */
  const width = shallowRef<number | null>(null)
  let restored = false
  /** While a dive is sent: the chat the first pane showed before it. */
  let following: PinKey | null | undefined

  const room = computed(() =>
    width.value === null
      ? null
      : splitRoom({
          body: width.value,
          foldedList: deps.foldedList(),
          portraits: deps.portraits()
        })
  )

  function facts(): SplitFacts {
    return {
      pins: deps.pins.views.value.map((pin) => ({
        key: pin.key,
        dwarfId: pin.kind === 'chat' ? (pin.key as SplitFacts['pins'][number]['dwarfId']) : null,
        needs: pin.text.needs
      })),
      focus: deps.pins.set.value.focus,
      room: room.value ?? 0
    }
  }

  function carry(effect: SplitEffect): void {
    if (effect.kind === 'write-wish') deps.writeWish(effect.split)
    else deps.bridge.patchUiSession({ kind: 'valle', patch: effect.patch })
  }

  function send(input: SplitInput): boolean {
    const step = stepSplit(set.value, input, facts())
    if (!step.ok) return false
    set.value = step.set
    step.effects.forEach(carry)
    return true
  }

  // S30.13, once: the pins open and the body measured.
  watch(
    [() => deps.factsRead.value, width],
    ([read, measured]) => {
      if (restored || !read || measured === null) return
      restored = true
      const remembered = deps.stores.value.session.valle.secondPaneDwarfId ?? null
      set.value = restoredSplit(deps.wish(), remembered, facts())
    },
    { immediate: true }
  )

  // S30.05, S30.06: on each change of the room, from the observer or the list folding; never polled.
  watch(room, () => {
    if (restored) send({ kind: 'resize' })
  })

  // Machine 29 moved: S30.07 for a dive, S30.10 for a shown pin gone, S30.08 / S30.09 for the focus.
  watch(
    () => deps.pins.set.value,
    (after, before) => {
      if (!restored) return
      if (following !== undefined) {
        send({ kind: 'follow', before: following })
        return
      }
      const keys = new Set(after.pins.map((pin) => pin.key))
      if (set.value.state === 'on' && set.value.panes.some((key) => !keys.has(key))) {
        send({ kind: 'pins' })
      } else if (after.focus !== before.focus) send({ kind: 'focused' })
    },
    { flush: 'sync' }
  )

  // Reset metrics (S30.12): the stores change only when read again after it.
  watch(
    () => deps.stores.value,
    () => {
      send({ kind: 'reset' })
    }
  )

  let stop: (() => void) | null = null
  watch(
    () => deps.body.value,
    (body) => {
      stop?.()
      stop =
        body === null
          ? null
          : deps.observe(body, (measured) => {
              width.value = measured
            })
    },
    { immediate: true }
  )
  if (getCurrentScope() !== undefined) onScopeDispose(() => stop?.())

  return {
    set,
    panes: computed(() => splitPanes(set.value, deps.pins.set.value.focus)),
    button: computed(() => splitButton(set.value, facts())),
    press() {
      send({ kind: 'press' })
    },
    sendPin(input) {
      following =
        input.kind === 'dive' && set.value.state === 'on' ? (set.value.panes[0] ?? null) : undefined
      try {
        return deps.pins.send(input)
      } finally {
        following = undefined
      }
    },
    send
  }
}
