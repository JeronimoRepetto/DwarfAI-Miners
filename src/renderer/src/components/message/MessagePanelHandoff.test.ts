// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ChatViewState,
  DwarfId,
  MessageId,
  MineId,
  ModeTransition,
  MessageView
} from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import { feedMessageOf } from '../../composables/useDwarfMessaging'
import { modeTransitionPart } from '../../composables/useModeTransition'
import { defaultDwarf } from '../../testing/factories'
import DwarfMessagePanel from './DwarfMessagePanel.vue'

/*
 * ISSUE-284: the MessagePanel hands its open chat to a mode transition run (ADR-025 item 3; ADR-024 item 3; 07
 * machine 9): as the source it flushes its draft and its view state before t0; as the target it takes them back
 * before its content shows. Mounted against the generated fake `window.api` (ADR-033 item 7).
 */

enableAutoUnmount(afterEach)

const MINE = '01920000-0000-7000-8000-00000000a001' as MineId
const RUN = '01920000-0000-7000-8000-00000000f001'

let listener: ((t: ModeTransition) => void) | null = null
const patches: unknown[] = []
const done: string[] = []
let carried: {
  draft: string
  selection: { start: number; end: number; direction: 'none' }
  anchor?: ChatViewState['scrollAnchor']
} = { draft: '', selection: { start: 0, end: 0, direction: 'none' as const } }

beforeEach(() => {
  vi.useFakeTimers({ now: 50_000 })
  listener = null
  patches.length = 0
  done.length = 0
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: createFakeWindowApi({
      onModeTransition: (h) => {
        listener = h
        return () => (listener = null)
      },
      modeTransitionDone: (p) => void done.push(p.transitionId),
      patchUiSession: (p) => void patches.push(p),
      getUiSession: () =>
        Promise.resolve({
          drafts: carried.draft === '' ? {} : { [DWARF]: carried.draft },
          // AMENDED for ISSUE-293 (was: always 'bottom'): a case may carry a message anchor.
          chatViews: {
            [DWARF]: { scrollAnchor: carried.anchor ?? 'bottom', selection: carried.selection }
          },
          askPicks: {},
          openChat: {},
          currentMine: {},
          valle: {}
        })
    })
  })
  // The window's part is running before any chat opens (the panel registers with it).
  modeTransitionPart()
})

afterEach(() => {
  modeTransitionPart().dispose()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'api')
})

const dwarf = defaultDwarf({ textDelivery: 'terminal' })
const DWARF = dwarf.id as DwarfId

describe('MessagePanel chat hand-off (ISSUE-284)', () => {
  it('[US-VETA-009.AC03, S9.01, S27.05] the open chat flushes its draft and selection as a source and takes them back as a target', async () => {
    const wrapper = mount(DwarfMessagePanel, { props: { dwarf } })
    const box = wrapper.find('.dm-composer textarea')
    await box.setValue('half a thought')
    const field = box.element as HTMLTextAreaElement
    field.setSelectionRange(2, 7, 'backward')

    listener!({
      transitionId: RUN,
      from: 'panel',
      to: 'hidden',
      t0: Date.now() + 16,
      role: 'source'
    })
    expect(patches).toEqual([
      { kind: 'draft', dwarfId: DWARF, text: 'half a thought' },
      {
        kind: 'chat-view',
        dwarfId: DWARF,
        view: { scrollAnchor: 'bottom', selection: { start: 2, end: 7, direction: 'backward' } }
      }
    ])

    // Another window carried the chat back with a changed draft and caret: they are shown before the content is.
    carried = { draft: 'carried back', selection: { start: 4, end: 4, direction: 'none' } }
    listener!({
      transitionId: '01920000-0000-7000-8000-00000000f002',
      from: 'veta',
      to: 'panel',
      t0: Date.now() + 16,
      role: 'target',
      chat: { dwarfId: DWARF, mineId: MINE }
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    expect(field.value).toBe('carried back')
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 4])
  })

  // APPENDED for ISSUE-293: the header's hand-off tool (screens/message.md, Header; US-MSG-010; US-DLG-006).
  it('[US-MSG-010.AC02, US-DLG-006.AC04] a chat opened directly in the Panel shows no Open in the Panel tool and no hand-off applies', async () => {
    const wrapper = mount(DwarfMessagePanel, { props: { dwarf } })
    expect(wrapper.find('button[title="Open in the Panel"]').exists()).toBe(false)
    // Its tools are the Panel's: History, Console, ⋯ and Close, and History is the Panel's own.
    const titles = wrapper.findAll('.dm-msg__tools button').map((b) => b.attributes('title'))
    expect(titles).toEqual(['Mine history', 'Open console', 'More', 'Close chat'])
    expect(wrapper.emitted('open-in-panel')).toBeUndefined()

    // Hosted in Veta, the same component offers it, first among the tools, and asks for the hand-off.
    const hosted = mount(DwarfMessagePanel, { props: { dwarf, hostedIn: 'veta' } })
    const tool = hosted.find('.dm-msg__tools button[title="Open in the Panel"]')
    expect(tool.exists()).toBe(true)
    expect(hosted.findAll('.dm-msg__tools button')[0]!.element).toBe(tool.element)
    await tool.trigger('click')
    expect(hosted.emitted('open-in-panel')).toHaveLength(1)
  })

  it('[US-DLG-006.AC02, BR-19] a chat hosted in Veta offers no mine-history request until the Panel can be opened on the history (pending amendment)', async () => {
    const hosted = mount(DwarfMessagePanel, { props: { dwarf, hostedIn: 'veta' } })
    // Neither the History tool nor the ⋯ menu's Mine history is drawn: hidden until built (BR-19).
    expect(hosted.find('.dm-msg__tools button[title="Mine history"]').exists()).toBe(false)
    await hosted.get('.dm-msg__tools button[title="More"]').trigger('click')
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) =>
      i.textContent?.trim()
    )
    expect(items).toContain('Open console')
    expect(items).not.toContain('Mine history')
    expect(hosted.emitted('history')).toBeUndefined()
  })

  // APPENDED for ISSUE-293: the scroll anchor by Host message id (ADR-024 item 3; OQ-37 B; INV-114).
  it('[US-DLG-006.AC03, INV-114, ADR-024] the scroll anchor is the first message in view by its Host id, and a target puts that message back at the same offset, or at the bottom when it holds no such message', async () => {
    const id = (n: number) =>
      `01920000-0000-7000-8000-00000000e${String(n).padStart(3, '0')}` as MessageId
    const view = (n: number): MessageView => ({
      id: id(n),
      dwarfId: DWARF,
      role: 'dwarf',
      text: `line ${n}`,
      attachments: [],
      providerTime: null,
      createdAt: 1_791_277_200_000 + n * 60_000
    })
    const feed = {
      readable: true,
      messages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => feedMessageOf(view(n)))
    }
    const wrapper = mount(DwarfMessagePanel, { props: { dwarf, feed }, attachTo: document.body })
    await flushPromises()
    // jsdom lays nothing out: each row is 100 px tall in a list 100 px high, scrolled by `scrollTop`.
    const list = wrapper.get('.dm-msg__log').element as HTMLElement
    let scrollTop = 0
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => void (scrollTop = value)
    })
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 })
    list.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    const bubbles = [...list.querySelectorAll<HTMLElement>('[data-message-id]')]
    expect(bubbles.map((b) => b.dataset['messageId'])).toEqual(
      feed.messages.map((_, i) => id(i + 1))
    )
    bubbles.forEach((bubble, i) => {
      bubble.getBoundingClientRect = () => ({ top: i * 100 - scrollTop }) as DOMRect
    })

    // As a source: line 3 starts the view, 50 px above its top.
    scrollTop = 250
    listener!({ transitionId: RUN, from: 'panel', to: 'veta', t0: Date.now() + 16, role: 'source' })
    expect(patches).toContainEqual({
      kind: 'chat-view',
      dwarfId: DWARF,
      view: { scrollAnchor: { messageId: id(3), offsetPx: 50 }, selection: expect.anything() }
    })

    // As a target: line 6 is put back 10 px into the view.
    carried = { ...carried, anchor: { messageId: id(6), offsetPx: 10 } }
    listener!({
      transitionId: '01920000-0000-7000-8000-00000000f003',
      from: 'veta',
      to: 'panel',
      t0: Date.now() + 16,
      role: 'target',
      chat: { dwarfId: DWARF, mineId: MINE }
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    expect(scrollTop).toBe(510)

    // A message this side has not loaded: the bottom.
    carried = { ...carried, anchor: { messageId: id(99), offsetPx: 10 } }
    listener!({
      transitionId: '01920000-0000-7000-8000-00000000f004',
      from: 'veta',
      to: 'panel',
      t0: Date.now() + 16,
      role: 'target',
      chat: { dwarfId: DWARF, mineId: MINE }
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    expect(scrollTop).toBe(900)
    carried = { draft: '', selection: { start: 0, end: 0, direction: 'none' } }
  })

  it('[INV-114, S24.18] a panel opened on a carried scroll anchor opens there, never pulled to the bottom a frame later', async () => {
    const id = (n: number) =>
      `01920000-0000-7000-8000-00000000e${String(n).padStart(3, '0')}` as MessageId
    const view = (n: number): MessageView => ({
      id: id(n),
      dwarfId: DWARF,
      role: 'dwarf',
      text: `line ${n}`,
      attachments: [],
      providerTime: null,
      createdAt: 1_791_277_200_000 + n * 60_000
    })
    const feed = { readable: true, messages: [1, 2, 3, 4, 5, 6].map((n) => feedMessageOf(view(n))) }
    let scrollTop = 0
    const wrapper = mount(DwarfMessagePanel, {
      props: { dwarf, feed, openAt: { messageId: id(4), offsetPx: 20 } },
      attachTo: document.body
    })
    // Laid out before the frame the panel opens on: rows 100 px tall in a list 100 px high.
    const list = wrapper.get('.dm-msg__log').element as HTMLElement
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => void (scrollTop = value)
    })
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 600 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 })
    list.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    await wrapper.vm.$nextTick()
    ;[...list.querySelectorAll<HTMLElement>('[data-message-id]')].forEach((bubble, i) => {
      bubble.getBoundingClientRect = () => ({ top: i * 100 - scrollTop }) as DOMRect
    })
    await vi.advanceTimersByTimeAsync(50)
    await flushPromises()
    expect(scrollTop).toBe(320)
  })
})
