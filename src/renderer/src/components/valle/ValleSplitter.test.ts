// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { useValleSplitter, type ValleSplitterPart } from '../../composables/useValleSplitter'
import type { ValleAnimationTiming, ValleClock, ValleFrames } from '../../lib/valle/flip'
import { defaultValleLayouts, type ValleLayouts, type VallePreset } from '../../lib/valle/preset'
import type { SplitterKey } from '../../lib/valle/splitter'
import ValleSplitter from './ValleSplitter.vue'

/*
 * The splitter as drawn and wired (ISSUE-305; 07 machine 33; UC-057; `DS/docs/components.md` molecules/splitter):
 * `role=separator` with live `aria-valuenow/min/max`; a drag, a key, a double click. jsdom lays nothing out, so the
 * geometry is injected: the body's width as its observer reports it, and each part's box read from the width the chat
 * zone is given (the chats sit right-aligned in a 1428 px body). The reset's clock is driven by hand.
 * TC-305-01: a reset FLIPs the content; the width itself jumps.
 */

const BODY = 1428

/** Frames and timers fire as `advance` moves time on. */
function manualClock() {
  let now = 0
  let id = 0
  const frames = new Map<number, (at: number) => void>()
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock: ValleClock & { advance(ms: number): void } = {
    frame(run) {
      frames.set((id += 1), run)
      return id
    },
    cancelFrame: (handle) => {
      frames.delete(handle as number)
    },
    now: () => now,
    set(run, ms) {
      timers.set((id += 1), { at: now + ms, run })
      return id
    },
    clear: (handle) => {
      timers.delete(handle as number)
    },
    advance(ms) {
      const until = now + ms
      while (now < until) {
        now = Math.min(now + 10, until)
        for (const [key, timer] of [...timers]) {
          if (timer.at > now) continue
          timers.delete(key)
          timer.run()
        }
        const due = [...frames.values()]
        frames.clear()
        for (const run of due) run(now)
      }
    }
  }
  return clock
}

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})

/** The splitter and the chat zone beside it, wired as the Valle root wires them. */
function harness(
  options: { preset?: VallePreset; layouts?: ValleLayouts; reduced?: boolean } = {}
) {
  const view = shallowRef({
    preset: options.preset ?? 'front',
    layouts: options.layouts ?? defaultValleLayouts()
  })
  const writes: ValleLayouts[] = []
  const bodyWidth = shallowRef<number | null>(BODY)
  const split = shallowRef(false)
  const stores = shallowRef({})
  const clock = manualClock()
  const animations: { element: Element; frames: ValleFrames; timing: ValleAnimationTiming }[] = []
  let part!: ValleSplitterPart
  const chats = shallowRef<HTMLElement | null>(null)
  const Host = defineComponent({
    setup() {
      part = useValleSplitter({
        view: () => view.value,
        writeLayouts: (layouts) => {
          writes.push(layouts)
          view.value = { ...view.value, layouts }
        },
        bodyWidth,
        foldedList: () => false,
        portraits: () => 4,
        split: () => split.value,
        stores,
        motion: {
          clock,
          reduced: () => options.reduced ?? false,
          targets: () => (chats.value === null ? [] : [chats.value]),
          // The chats end at the body's right edge: their left is what the chat zone's width leaves.
          box: (element) => {
            const width = Number.parseFloat((element as HTMLElement).style.width)
            return { left: BODY - width, top: 40, width, height: 600 }
          },
          animate: (element, frames, timing) => {
            animations.push({ element, frames, timing })
          },
          afterRender: (run) => {
            void nextTick(run)
          }
        }
      })
      return () =>
        h('div', { class: 'body' }, [
          h(ValleSplitter, {
            width: part.width.value,
            min: part.range.value.min,
            max: part.range.value.max,
            dragging: part.set.value.state === 'dragging',
            onPress: (x: number) => part.send({ kind: 'press', x }),
            onMove: (x: number) => part.send({ kind: 'move', x }),
            onRelease: () => part.send({ kind: 'release' }),
            onCancel: () => part.send({ kind: 'cancel' }),
            onKey: (key: SplitterKey) => part.send({ kind: 'key', key }),
            onReset: () => part.send({ kind: 'double-click' })
          }),
          h('aside', { ref: chats, class: 'chats', style: { width: `${part.width.value}px` } })
        ])
    }
  })
  wrapper = mount(Host, { attachTo: document.body })
  const bar = () => wrapper!.get('[role="separator"]')
  const chatWidth = () => wrapper!.get('.chats').attributes('style')
  return { wrapper, bar, chatWidth, part: () => part, writes, bodyWidth, split, clock, animations }
}

/** jsdom has no PointerEvent: a mouse event of the pointer's type, primary button, pointer 1. */
async function pointer(target: Element, type: string, clientX: number): Promise<void> {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  target.dispatchEvent(event)
  await nextTick()
}

const STORED: ValleLayouts = {
  control: { ...defaultValleLayouts().control, chatWidth: 520 },
  front: { ...defaultValleLayouts().front, chatWidth: 600 }
}

describe('ValleSplitter (ISSUE-305)', () => {
  it('[US-VALLE-005.AC05, S33.06, S33.07, NFR-PERF-01] Enter or a double click resets to the default by FLIPping the content, never animating the width', async () => {
    for (const how of ['Enter', 'double-click'] as const) {
      const world = harness({ layouts: STORED })
      expect(world.chatWidth()).toContain('width: 600px')
      if (how === 'Enter') await world.bar().trigger('keydown', { key: 'Enter' })
      else await world.bar().trigger('dblclick')
      await nextTick()

      // Only the Work front's stored width is cleared; the Control room's stays 520 px.
      expect(world.writes.at(-1)?.front.chatWidth, how).toBe(0)
      expect(world.writes.at(-1)?.control).toBe(STORED.control)
      // The width jumps to the default at once: 1428 − 56 − 12 − 18 − 232 − 6 − max(320, 400).
      expect(world.chatWidth(), how).toContain('width: 704px')
      expect(world.part().set.value.state).toBe('resetting')

      // The content plays from where it stood: 104 px further right, before the width grew.
      expect(world.animations, how).toHaveLength(1)
      const [played] = world.animations
      expect(played!.element.classList.contains('chats')).toBe(true)
      expect(played!.frames[0]!.transform).toBe('translate(104px, 0px)')
      expect(played!.frames.at(-1)!.transform).toBe('none')
      for (const frame of played!.frames) {
        expect(Object.keys(frame).sort(), 'only transform plays').toEqual([
          'transform',
          'transformOrigin'
        ])
      }
      expect(played!.timing.duration).toBe(180)

      // S33.07: the FLIP done, back at rest.
      world.clock.advance(170)
      expect(world.part().set.value.state).toBe('resetting')
      world.clock.advance(20)
      expect(world.part().set.value.state).toBe('rest')
      wrapper!.unmount()
      wrapper = undefined
    }

    // Reduced motion: nothing plays and the reset settles in the same frame.
    const still = harness({ layouts: STORED, reduced: true })
    await still.bar().trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect(still.chatWidth()).toContain('width: 704px')
    expect(still.animations).toEqual([])
    still.clock.advance(10)
    expect(still.part().set.value.state).toBe('rest')
  })

  it('[NFR-A11Y-06] the splitter is a separator with live aria-valuenow, aria-valuemin and aria-valuemax', async () => {
    const world = harness({ layouts: STORED })
    const bar = world.bar()
    expect(bar.attributes()).toMatchObject({
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize the chats',
      title: 'Resize the chats · drag, or double-click to reset'
    })
    const aria = () => [
      bar.attributes('aria-valuenow'),
      bar.attributes('aria-valuemin'),
      bar.attributes('aria-valuemax')
    ]
    expect(aria()).toEqual(['600', '340', '784'])

    // A drag: live while the pointer moves, nothing written until the release.
    await pointer(bar.element, 'pointerdown', 800)
    await pointer(bar.element, 'pointermove', 750)
    expect(aria()).toEqual(['650', '340', '784'])
    expect(world.chatWidth()).toContain('width: 650px')
    expect(world.writes).toEqual([])
    await pointer(bar.element, 'pointerup', 750)
    expect(world.writes.at(-1)?.front.chatWidth).toBe(650)

    // The range moves with the window and the split; the stored width is kept.
    world.bodyWidth.value = 1200
    await nextTick()
    expect(aria()).toEqual(['556', '340', '556'])
    world.split.value = true
    world.bodyWidth.value = BODY
    await nextTick()
    expect(aria()).toEqual(['650', '640', '784'])

    // Keys: ← widens by 16 px, Home and End jump to the ends, each committed at once.
    await bar.trigger('keydown', { key: 'ArrowLeft' })
    expect(aria()[0]).toBe('666')
    await bar.trigger('keydown', { key: 'End' })
    expect(aria()[0]).toBe('784')
    await bar.trigger('keydown', { key: 'Home' })
    expect(aria()[0]).toBe('640')
    expect(world.writes.map((layouts) => layouts.front.chatWidth)).toEqual([650, 666, 784, 640])
  })
})
