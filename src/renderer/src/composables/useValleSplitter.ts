/*
 * The splitter wired to the Valle window (07 machine 33; UC-057; 14 §2.2 A-N21, §3.9 `ValleLayoutControl.chatWidth`,
 * `ValleLayoutFront.chatWidth`; ADR-024 items 1, 4; NFR-PERF-01; ISSUE-305): the splitter set (`splitter.ts`) stepped
 * on each input, the chat zone's width derived from it, and every effect carried out.
 *
 * - The width shown is the live drag width, else the preset's stored width clamped to its range now (its default when
 *   nothing is stored). The range reads the body's width from the split's one observer, the Work front's list, the split
 *   shown and the mine's roster, so a resize, a fold, a split or a roster change re-clamps it as it happens, never on a
 *   timer (S33.08, S33.12); the stored width is kept until the person commits again.
 * - A commit goes through the preset's own A-N21 write of both layouts, this preset's width alone changed (S33.02,
 *   S33.04, S33.05, S33.06): one writer of `valleLayout`.
 * - The reset (S33.06): the parts are measured where they stand, the width jumps to the default, and once it is rendered
 *   each part plays by FLIP from where it was, `transform` alone (`DS` `DM.motion.flip`, `--dur-panel`); the width
 *   never animates. The run ends on the first of its duration, its watchdog, or the first frame under reduced motion
 *   (S33.07, NFR-TIM-16).
 * - Reset metrics (the stores read again) gives the default width (S33.10); "Reset preset" steps it through `send`.
 *
 * The motion (clock, geometry, animation runner) is injected; the Valle root hands the browser's.
 */
import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type Ref } from 'vue'
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
import type { ValleLayouts, VallePreset } from '../lib/valle/preset'
import {
  shownWidth,
  SPLITTER_REST,
  splitterRange,
  stepSplitter,
  withChatWidth,
  type SplitterEffect,
  type SplitterFacts,
  type SplitterInput,
  type SplitterRange,
  type SplitterSet
} from '../lib/valle/splitter'

/** How the reset plays: its clock, reduced motion, the parts it moves, and how they are measured and animated. */
export interface ValleSplitterMotion {
  clock: ValleClock
  reduced(): boolean
  /** The zones' content the reset FLIPs: the chat zone and the splitter. */
  targets(): readonly Element[]
  box(element: Element): ValleBox
  animate(element: Element, frames: ValleFrames, timing: ValleAnimationTiming): void
  /** Runs once the new width is rendered. */
  afterRender(run: () => void): void
}

export interface ValleSplitterDeps {
  /** The preset shown and both layouts (machine 28's view). */
  view(): { readonly preset: VallePreset; readonly layouts: ValleLayouts }
  /** Writes both layouts at once (A-N21, through the preset). */
  writeLayouts(layouts: ValleLayouts): void
  /** The body's content width, from the split's one observer. */
  bodyWidth: Readonly<Ref<number | null>>
  /** The Work front's compact list is folded. */
  foldedList(): boolean
  /** The portraits of the Work front's mine. */
  portraits(): number
  /** Two chats are side by side (machine 30 `on`). */
  split(): boolean
  /** The stores read before the first paint, read again after Reset metrics. */
  stores: Readonly<Ref<unknown>>
  /** The reset's motion; without it, a reset settles at once. */
  motion?: ValleSplitterMotion
}

export interface ValleSplitterPart {
  set: Readonly<Ref<SplitterSet>>
  /** The chat zone's width now. */
  width: Readonly<Ref<number>>
  /** The preset's range now. */
  range: Readonly<Ref<SplitterRange>>
  /** Steps machine 33; answers whether the input was taken. */
  send(input: SplitterInput): boolean
}

export function useValleSplitter(deps: ValleSplitterDeps): ValleSplitterPart {
  const set = shallowRef<SplitterSet>(SPLITTER_REST)
  let run: ValleRun | null = null

  const facts = computed((): SplitterFacts => {
    const { preset, layouts } = deps.view()
    return {
      preset,
      stored: layouts[preset].chatWidth,
      geometry: {
        body: deps.bodyWidth.value,
        foldedList: deps.foldedList(),
        portraits: deps.portraits(),
        split: deps.split()
      }
    }
  })
  const range = computed(() => splitterRange(facts.value.preset, facts.value.geometry))

  function settle(): void {
    run = null
    send({ kind: 'settled' })
  }

  /** S33.06: measured now, played once the default width is rendered. */
  function flip(): void {
    const motion = deps.motion
    if (motion === undefined) {
      queueMicrotask(() => send({ kind: 'settled' }))
      return
    }
    const reduced = motion.reduced()
    const ms = reduced ? 0 : VALLE_MOTION.swap
    if (!reduced) {
      const parts = motion.targets().map((element) => ({ element, first: motion.box(element) }))
      motion.afterRender(() => {
        for (const { element, first } of parts) {
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
    run = startValleRun(motion.clock, ms, settle)
  }

  function carry(effect: SplitterEffect): void {
    if (effect.kind === 'flip') flip()
    else deps.writeLayouts(withChatWidth(deps.view().layouts, effect.preset, effect.chatWidth))
  }

  function send(input: SplitterInput): boolean {
    const step = stepSplitter(set.value, input, facts.value)
    if (!step.ok) return false
    if (set.value.state === 'resetting' && step.set.state !== 'resetting') {
      run?.stop()
      run = null
    }
    set.value = step.set
    step.effects.forEach(carry)
    return true
  }

  // S33.08: the range moved; the width re-clamps through `facts`, nothing is written.
  watch(range, () => {
    send({ kind: 'reflow' })
  })
  // S33.09: the preset shown changed.
  watch(
    () => deps.view().preset,
    () => {
      send({ kind: 'preset' })
    }
  )
  // S33.10: Reset metrics, the stores read again.
  watch(
    () => deps.stores.value,
    () => {
      send({ kind: 'reset' })
    }
  )
  if (getCurrentScope() !== undefined) onScopeDispose(() => run?.stop())

  return {
    set,
    width: computed(() => shownWidth(set.value, facts.value)),
    range,
    send
  }
}
