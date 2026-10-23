// @vitest-environment jsdom
import type { MineId, UiSessionPatch } from '@dwarfai/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import { VALLE_STORE_DEFAULTS, type ValleStores } from '../../composables/useValleStores'
import type { ValleClock } from '../../lib/valle/flip'
import {
  BORIN,
  DAIN,
  EREBOR,
  MORIA,
  dwarfWire,
  mineWire,
  snapshotPage
} from '../../lib/veta/testing/vetaFixtures'
import { createFakeAudioPlayer } from '../../lib/audio/fakeAudioPlayer'
import HistoryPanel from '../history/HistoryPanel.vue'
import DwarfMessagePanel from '../message/DwarfMessagePanel.vue'
import ValleApp from './ValleApp.vue'
import { valleBridgeOf } from './valleEntry'

/*
 * The mine's history as a drawer under the Work front's chat tabs and panes (07 machine 36; US-VALLE-011; UC-061), in the
 * Valle root over the generated fake `window.api`: the drawer hosts the Panel's own history panel, rises and sinks with
 * a fade, never moves the chats above it, and closes at once on the way out.
 *
 * jsdom lays nothing out and has no Web Animations: the browser's `animate` is replaced by a recorder, so a case reads
 * which element moved, how, and that nothing else did.
 */

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** The clock the root's runs read, driven by hand: frames and timers fire as `advance` moves time on. */
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

/** Every motion the browser was asked to play: on which element, its frames and its duration. */
interface Played {
  readonly element: Element
  readonly frames: Keyframe[]
  readonly duration: number
}
let played: Played[] = []
beforeEach(() => {
  played = []
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value(this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
      played.push({ element: this, frames, duration: Number(options.duration) })
      return { cancel: () => undefined, onfinish: null } as unknown as Animation
    }
  })
})

let root: VueWrapper | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  delete (HTMLElement.prototype as { animate?: unknown }).animate
  delete (document as { visibilityState?: unknown }).visibilityState
  Reflect.deleteProperty(window, 'api')
  document.body.innerHTML = ''
})

/** Valle in the Work front on Moria, Borin's chat pinned and shown; Dain works in Erebor. */
async function mountFront(stores: Partial<ValleStores> = {}) {
  const patches: UiSessionPatch[] = []
  const reads: MineId[] = []
  const clock = manualClock()
  const api = createFakeWindowApi({
    onHostEvent: () => () => {},
    queryProjects: () =>
      Promise.resolve({
        answered: true,
        projects: [MORIA, EREBOR].map((id, at) => ({
          id,
          path: mineWire(id).path,
          name: mineWire(id).name,
          declared: true,
          addedAt: at,
          live: true
        }))
      }) as never,
    getMineHistory: (asked) => {
      const mineId = asked as unknown as MineId
      reads.push(mineId)
      return Promise.resolve({
        ok: true,
        value: {
          mineId,
          speakers: [
            {
              dwarfId: mineId === MORIA ? BORIN : DAIN,
              displayName: `crew of ${mineWire(mineId).name}`,
              rank: 'worker',
              providerId: 'claude',
              departed: false,
              messages: []
            }
          ]
        }
      }) as never
    },
    getHostSnapshot: () =>
      Promise.resolve(
        snapshotPage(10, {
          minesEverKnown: true,
          mines: [mineWire(MORIA), mineWire(EREBOR)],
          dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)]
        })
      ) as never,
    setUiPreference: (write) => Promise.resolve(write) as never,
    patchUiSession: (patch) => {
      patches.push(patch as UiSessionPatch)
    },
    moveToMode: () => Promise.resolve({ ok: true }) as never
  })
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
  root = mount(ValleApp, {
    attachTo: document.body,
    props: {
      bridge: valleBridgeOf(api),
      stores: {
        ...VALLE_STORE_DEFAULTS,
        preset: 'front',
        lastFrontMineId: MORIA,
        pins: [{ dwarfId: BORIN, mineId: MORIA, order: 0 }],
        ...stores
      },
      observer: () => new InertObserver(),
      bodyObserver: () => () => {},
      clock,
      audioPlayer: createFakeAudioPlayer()
    }
  })
  await flushPromises()
  clock.advance(330)
  await flushPromises()
  const wrapper = root
  const drawer = () => wrapper.find('[data-valle-drawer]')
  const historyOpen = () =>
    patches.filter((patch) => patch.kind === 'valle' && 'historyOpen' in patch.patch)
  return { root: wrapper, clock, patches, reads, drawer, historyOpen }
}

/** "Mine history" in the Work front's mine toolbar. */
const toolbarHistory = (root: VueWrapper) =>
  root.find('[data-valle-front-mine] button[aria-label="Mine history · opens under the chats"]')

/** Presses "Mine history" in the Work front's mine toolbar. */
async function openHistory(root: VueWrapper): Promise<void> {
  const button = toolbarHistory(root)
  expect(button.exists()).toBe(true)
  await button.trigger('click')
}

describe('the history drawer in the Work front (machine 36)', () => {
  it('[US-VALLE-011.AC01] the chat tabs and panes above the drawer keep their size and place while it opens', async () => {
    const { root, clock, drawer, historyOpen } = await mountFront()
    const tabs = root.get('.dm-cdeck__head').element
    const pane = root.get('.dm-cdeck__pane').element
    const chat = root.get(`[data-valle-chat="${BORIN}"]`).element
    const styles = [tabs, pane, chat].map((element) => element.getAttribute('style'))
    played = []

    const button = toolbarHistory(root)
    expect(button.exists()).toBe(true)
    await button.trigger('click')
    await flushPromises()
    // Under the tabs and the panes, inside the deck, after them.
    expect(drawer().exists()).toBe(true)
    const deck = root.get('.dm-cdeck')
    expect(deck.attributes('data-drawer')).toBe('open')
    const order = [...deck.element.children]
    expect(order.indexOf(drawer().element)).toBeGreaterThan(
      order.indexOf(root.get('.dm-cdeck__panes').element)
    )
    // Only the drawer moves: it rises from 16 px below with a fade over 180 ms.
    expect(played.map((motion) => motion.element)).toEqual([drawer().element])
    expect(played[0]?.frames).toEqual([
      { opacity: 0, transform: 'translateY(16px)' },
      { opacity: 1, transform: 'none' }
    ])
    expect(played[0]?.duration).toBe(180)
    expect(drawer().attributes('data-drawer-state')).toBe('opening')
    clock.advance(180)
    await flushPromises()
    expect(drawer().attributes('data-drawer-state')).toBe('open')
    // The tabs, the pane and its chat are the very elements they were, untouched by any style or motion.
    expect(root.get('.dm-cdeck__head').element).toBe(tabs)
    expect(root.get('.dm-cdeck__pane').element).toBe(pane)
    expect(root.get(`[data-valle-chat="${BORIN}"]`).element).toBe(chat)
    expect([tabs, pane, chat].map((element) => element.getAttribute('style'))).toEqual(styles)
    expect(played).toHaveLength(1)
    // A-N18: the session's `valle.historyOpen`, nothing stored.
    expect(historyOpen()).toEqual([{ kind: 'valle', patch: { historyOpen: true } }])
  })

  it("[US-VALLE-011.AC04] the drawer shows the same content as the Panel's history panel for that mine", async () => {
    const { root, reads, drawer } = await mountFront()
    await openHistory(root)
    await flushPromises()
    // The Panel's own history panel, read through A-19 for the Work front's mine, with what the Host answered.
    const panel = drawer().getComponent(HistoryPanel)
    expect(reads).toEqual([MORIA])
    expect(panel.attributes('aria-label')).toBe('Mine history, moria')
    expect((panel.props('mine') as { id: string }).id).toBe(MORIA)
    expect(panel.props('history')).toMatchObject({
      readable: true,
      speakers: [{ id: BORIN, name: 'crew of moria' }]
    })
  })

  it("[US-VALLE-011.AC02, S36.03] the history's own close sinks the drawer with a fade, then it is gone", async () => {
    const { root, clock, drawer, historyOpen } = await mountFront()
    await openHistory(root)
    clock.advance(180)
    await flushPromises()
    played = []
    await drawer().get('button[title="Close history"]').trigger('click')
    await flushPromises()
    expect(drawer().attributes('data-drawer-state')).toBe('closing')
    expect(played.map((motion) => motion.element)).toEqual([drawer().element])
    expect(played[0]?.frames).toEqual([
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateY(16px)' }
    ])
    expect(played[0]?.duration).toBe(90)
    clock.advance(90)
    await flushPromises()
    expect(drawer().exists()).toBe(false)
    expect(root.get('.dm-cdeck').attributes('data-drawer')).toBeUndefined()
    expect(historyOpen().at(-1)).toEqual({ kind: 'valle', patch: { historyOpen: false } })
  })

  it('[US-VALLE-011.AC03, S36.04] climbing out of the Work front, or Valle hidden, closes the drawer at once with no fade', async () => {
    const { root, clock, drawer, historyOpen } = await mountFront()
    await openHistory(root)
    clock.advance(180)
    await flushPromises()
    played = []
    // Esc with no other layer open climbs out (S28.11).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(root.get('[data-valle-root]').attributes('data-preset')).toBe('control')
    expect(drawer().exists()).toBe(false)
    expect(played.filter((motion) => motion.duration === 90)).toEqual([])
    expect(historyOpen().at(-1)).toEqual({ kind: 'valle', patch: { historyOpen: false } })

    // Back in the Work front, opened again, then the window hidden.
    clock.advance(330)
    await root.get('[data-preset-tab="front"]').trigger('click')
    clock.advance(330)
    await flushPromises()
    await openHistory(root)
    await flushPromises()
    expect(drawer().exists()).toBe(true)
    played = []
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(drawer().exists()).toBe(false)
    expect(played).toEqual([])
    expect(historyOpen().at(-1)).toEqual({ kind: 'valle', patch: { historyOpen: false } })
  })

  it("[S36.05] a Work front swap keeps the drawer open on the new mine's history", async () => {
    const { root, clock, reads, drawer } = await mountFront()
    await openHistory(root)
    clock.advance(180)
    await flushPromises()
    await root.get(`[data-valle-row="${EREBOR}"]`).trigger('click')
    clock.advance(330)
    await flushPromises()
    expect(drawer().attributes('data-drawer-state')).toBe('open')
    expect(drawer().getComponent(HistoryPanel).attributes('aria-label')).toBe(
      'Mine history, erebor'
    )
    expect(reads).toEqual([MORIA, EREBOR])
  })

  it('[US-VALLE-011.AC01, S36.01] a mine-history request from a chat in the deck opens the drawer, and the History bar under the deck says it is open', async () => {
    const { root, drawer } = await mountFront()
    const bar = root.find('.dm-cdeck__histbar')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('aria-expanded')).toBe('false')
    expect(bar.text()).toContain('History')
    expect(bar.text()).toContain('opens under the chats')
    root.getComponent(DwarfMessagePanel).vm.$emit('history')
    await flushPromises()
    expect(drawer().exists()).toBe(true)
    expect(drawer().getComponent(HistoryPanel).attributes('aria-label')).toBe('Mine history, moria')
    expect(root.get('.dm-cdeck__histbar').attributes('aria-expanded')).toBe('true')
  })

  it("[S31.11] a mine-history request from a chat in the Control room stack shows it in that mine's zone, never a drawer", async () => {
    const { root, drawer } = await mountFront({
      preset: 'control',
      mosaicOrder: [MORIA, EREBOR]
    })
    root.getComponent(DwarfMessagePanel).vm.$emit('history')
    await flushPromises()
    expect(drawer().exists()).toBe(false)
    const column = root.get(`[data-valle-column="${MORIA}"]`)
    expect(column.attributes('data-content')).toBe('history')
    expect(column.find('.dm-hist').attributes('aria-label')).toBe('Mine history, moria')
  })
})
