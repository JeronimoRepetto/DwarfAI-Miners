// @vitest-environment jsdom
import type { DwarfId, DwarfWire, MineId, MineWire } from '@dwarfai/contracts'
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { useValleNeedsYou } from '../../composables/useValleNeedsYou'
import type { NeedsYouEntry, NeedsYouQueue } from '../../lib/valle/needsYou'
import NeedsYouCounter from './NeedsYouCounter.vue'
import NeedsYouQueueView from './NeedsYouQueue.vue'
import queueSource from './NeedsYouQueue.vue?raw'

/*
 * The needs-you counter and the footer's row (07 machine 34; US-VALLE-004, US-VALLE-012; NFR-PERF-03) drawn from the
 * Host's queue through `useValleNeedsYou`, over a hand-written read model whose queue a case replaces as the Host's
 * frames would: the row and the counter patch in place, never rebuilt.
 */
const MORIA = '01920000-0000-7000-8000-00000000a001' as MineId
const EREBOR = '01920000-0000-7000-8000-00000000a002' as MineId
const id = (n: number): DwarfId =>
  `01920000-0000-7000-8000-00000000d${String(n).padStart(3, '0')}` as DwarfId
const NALI = id(1)
const BORIN = id(2)
const DAIN = id(3)
const NAMES: Record<string, string> = { [NALI]: 'nali', [BORIN]: 'borin', [DAIN]: 'dain' }

const dwarf = (dwarfId: DwarfId, mineId: MineId): DwarfWire =>
  ({ id: dwarfId, mineId, baseName: NAMES[dwarfId] ?? 'dwarf', customName: null }) as DwarfWire
const mine = (mineId: MineId, name: string): MineWire => ({ id: mineId, name }) as MineWire
const entry = (dwarfId: DwarfId, mineId: MineId, askedAt: number): NeedsYouEntry => ({
  dwarfId,
  mineId,
  askedAt
})

let root: VueWrapper | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.innerHTML = ''
})

/** The counter and the row over a read model whose queue the case sets, as the read model's frames would. */
function world(initial: NeedsYouQueue, extra: DwarfWire[] = []) {
  const queue = shallowRef<NeedsYouQueue>(initial)
  const model = {
    needsYou: queue,
    dwarfs: shallowRef<readonly DwarfWire[]>([
      dwarf(NALI, MORIA),
      dwarf(BORIN, EREBOR),
      dwarf(DAIN, MORIA),
      ...extra
    ]),
    mines: shallowRef<readonly MineWire[]>([mine(MORIA, 'Moria'), mine(EREBOR, 'Erebor')]),
    askOf: (dwarfId: DwarfId) =>
      dwarfId === BORIN ? ('permission' as const) : ('question' as const)
  }
  const Harness = defineComponent({
    setup() {
      const needs = useValleNeedsYou({
        model,
        preset: () => 'control',
        frontMine: () => null,
        jump: { reveal: () => {}, pin: () => {}, current: () => {}, swap: () => {} }
      })
      return () =>
        h('div', [
          h(NeedsYouCounter, { view: needs.counter.value }),
          h(NeedsYouQueueView, { entries: needs.entries.value })
        ])
    }
  })
  root = mount(Harness, { attachTo: document.body })
  return { queue, root }
}

const entries = (wrapper: VueWrapper): HTMLElement[] =>
  wrapper.findAll<HTMLElement>('.dm-vq__entry').map((found) => found.element)

describe('the needs-you counter and queue (ISSUE-306)', () => {
  it('[US-VALLE-004.AC05, US-VALLE-012.AC03, NFR-PERF-03] a new asker appends at the end and the counter updates in place; existing entries neither move nor re-render', async () => {
    // The Host's order: NALI asked first, then BORIN (not the order of their names).
    const w = world([entry(NALI, MORIA, 10), entry(BORIN, EREBOR, 20)])
    await nextTick()
    const counter = w.root.get('[data-needs-counter]').element
    expect(counter.textContent).toContain('2 need you')
    const before = entries(w.root)
    expect(before.map((e) => e.getAttribute('aria-label'))).toEqual([
      'nali has a question in Moria',
      'borin asks for a permission in Erebor'
    ])
    // Every change inside the entries and the counter is recorded from here on.
    const changes: MutationRecord[] = []
    const observer = new MutationObserver((records) => changes.push(...records))
    for (const element of [...before, counter.querySelector('.dm-vbar__q')!]) {
      observer.observe(element, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      })
    }
    const row = w.root.get('.dm-vq__row').element
    const rowChanges: MutationRecord[] = []
    const rowObserver = new MutationObserver((records) => rowChanges.push(...records))
    rowObserver.observe(row, { childList: true })

    // DAIN starts asking: the Host appends it at the end.
    w.queue.value = [...w.queue.value, entry(DAIN, MORIA, 30)]
    await nextTick()
    const after = entries(w.root)
    expect(after.map((e) => e.getAttribute('data-id'))).toEqual([NALI, BORIN, DAIN])
    // The same elements, in the same places: nothing moved, nothing inside them was touched.
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(changes.splice(0)).toEqual([])
    expect(rowChanges.flatMap((r) => [...r.removedNodes])).toEqual([])
    expect(rowChanges.flatMap((r) => [...r.addedNodes])).toEqual([after[2]])
    // The counter is the same button, its number updated in place, its accessible name counting.
    expect(w.root.get('[data-needs-counter]').element).toBe(counter)
    expect(counter.textContent).toContain('3 need you')
    expect(counter.getAttribute('aria-label')).toBe('3 waiting on you. Jump to the next one')
    observer.disconnect()
    rowObserver.disconnect()
  })

  it('[US-VALLE-012.AC05] more entries than fit scroll sideways without wrapping or shrinking, the newest out of view', async () => {
    const crew = Array.from({ length: 24 }, (_, at) => id(100 + at))
    const w = world(
      crew.map((dwarfId, at) => entry(dwarfId, MORIA, at)),
      crew.map((dwarfId) => dwarf(dwarfId, MORIA))
    )
    await nextTick()
    // The fixed 48 px strip; its row scrolls sideways, never wraps; an entry never shrinks or wraps (DS needs-queue).
    const style = queueSource
      .slice(queueSource.indexOf('<style'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
    const rule = (selector: string): string =>
      new RegExp(`${selector.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(style)?.[1] ?? ''
    expect(rule('.dm-vq')).toContain('height: 48px;')
    expect(rule('.dm-vq__row')).toContain('overflow-x: auto;')
    expect(rule('.dm-vq__row')).not.toContain('flex-wrap: wrap')
    expect(rule('.dm-vq__entry')).toContain('flex: none;')
    expect(rule('.dm-vq__entry')).toContain('white-space: nowrap;')
    // The oldest first: the ones past the row's end are the newest.
    expect(entries(w.root).map((e) => e.getAttribute('data-id'))).toEqual(crew)
    // A new arrival never scrolls the row to it: the oldest stay in view (jsdom has no layout; the scroll is watched).
    const row = w.root.get('.dm-vq__row').element as HTMLElement
    const scrolled: number[] = []
    Object.defineProperty(row, 'scrollLeft', {
      configurable: true,
      get: () => 0,
      set: (left: number) => scrolled.push(left)
    })
    const intoView: Element[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      intoView.push(this)
    }
    w.queue.value = [...w.queue.value, entry(NALI, MORIA, 99)]
    await nextTick()
    expect(entries(w.root).at(-1)?.getAttribute('data-id')).toBe(NALI)
    expect(scrolled).toEqual([])
    expect(intoView).toEqual([])
    Element.prototype.scrollIntoView = original
  })
})
