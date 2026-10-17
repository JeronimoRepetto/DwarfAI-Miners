// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_CHANNEL_REASON, SESSION_CLOSED_REASON } from '../../lib/delivery/actionBar'
import {
  COPY_LABEL,
  COPY_TITLE,
  RETRY_LABEL,
  RETRY_TITLE
} from '../../lib/delivery/deliveryVerdict'
import type { MessageEcho } from '../../lib/message/echo'
import { defaultDwarf } from '../../testing/factories'
import type {
  DwarfAttachment,
  DwarfAttachmentPick,
  DwarfFeedResult,
  DwarfSendState,
  FeedMessage
} from '../../types'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import DwarfMessagePanel from './DwarfMessagePanel.vue'

/*
 * ISSUE-257 (EPIC-16): the MessagePanel's composer, log, bubbles and marks against the pinned
 * design (design-system docs, anatomy.md `organisms/message-panel` and `molecules/composer`;
 * screens/message.md). One test per acceptance criterion of the issue, each carrying its ids.
 * Drafts kept across a switch, cleared by a send and dropped on a death are the dock's half
 * (MessagePanelDrafts.test.ts); a close and reopen is the L9 case (e2e/panel/drafts.e2e.ts).
 */

enableAutoUnmount(afterEach)

/** The design's own sentences, copied from anatomy.md rather than from the code under test. */
const DESIGN = {
  hint: 'Enter sends · Shift+Enter new line · drop files to attach',
  send: 'Send',
  attach: 'Attach a file',
  seen: 'Seen acting on it',
  closed: 'This session can no longer receive messages.',
  noChannelYet: "This session type can't receive messages yet.",
  notDelivered: 'Not delivered',
  retry: ['Retry', 'Send the same message again'],
  copy: ['Copy', 'Copy the message text']
} as const

function heldFeed(messages: readonly FeedMessage[]): DwarfFeedResult {
  return { readable: true, messages: [...messages], source: 'held' }
}

const HELD: FeedMessage[] = [
  { role: 'user', text: 'dig here', timestamp: '2026-09-03T09:00:00.000Z' },
  { role: 'assistant', text: 'Found the seam.', timestamp: '2026-09-03T09:00:01.000Z' }
]

function echo(overrides: Partial<MessageEcho> = {}): MessageEcho {
  return {
    id: 'e1',
    text: 'dig deeper',
    sentAt: Date.parse('2026-09-09T10:00:00.000Z'),
    state: { phase: 'sending' },
    ...overrides
  }
}

function panel(props: Record<string, unknown> = {}) {
  return mount(DwarfMessagePanel, {
    props: {
      dwarf: defaultDwarf({ textDelivery: 'terminal' }),
      feed: heldFeed(HELD),
      ...props
    }
  })
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

describe('MessagePanel composer (ISSUE-257)', () => {
  it('[US-MSG-001.AC02] Shift+Enter inserts a line break and sends nothing', async () => {
    const wrapper = panel()
    const box = wrapper.find('.dm-composer textarea')
    await box.setValue('first line')
    const shiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    box.element.dispatchEvent(shiftEnter)
    await flushPromises()
    // The browser's own line break goes in: nothing cancels the key.
    expect(shiftEnter.defaultPrevented).toBe(false)
    expect(wrapper.emitted('send')).toBeUndefined()
    // Enter alone is the send, so the two keys are told apart.
    await box.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([[{ text: 'first line', pressEnter: true }]])
  })

  it('[US-MSG-001.AC06] an empty composer offers nothing to send', async () => {
    const wrapper = panel()
    const send = () => wrapper.find('.dm-composer__send')
    expect(send().attributes('disabled')).toBeDefined()
    // Blank space is nothing to send either.
    await wrapper.find('.dm-composer textarea').setValue('   \n ')
    expect(send().attributes('disabled')).toBeDefined()
    await send().trigger('click')
    expect(wrapper.emitted('send')).toBeUndefined()
    await wrapper.find('.dm-composer textarea').setValue('dig')
    expect(send().attributes('disabled')).toBeUndefined()
  })

  it("[US-MSG-001.AC07, NFR-A11Y-09] the placeholder and every accessible name use the dwarf's current display name", async () => {
    const base = 'Sample Worker'
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', name: base, customName: 'Gimli' })
    })
    const named = () =>
      wrapper
        .findAll('[aria-label], [placeholder]')
        .flatMap((el) => [el.attributes('aria-label'), el.attributes('placeholder')])
        .filter((value): value is string => value !== undefined)
    expect(wrapper.find('.dm-composer textarea').attributes('placeholder')).toBe('Write to Gimli…')
    expect(wrapper.attributes('aria-label')).toBe('Chat with Gimli')
    expect(wrapper.find('.dm-msg__log').attributes('aria-label')).toBe('Conversation with Gimli')
    expect(wrapper.find('.dm-msg__head [aria-label^="Gimli"]').exists()).toBe(true)
    // The base name is shown under a custom name, but nothing is NAMED by it.
    expect(named().filter((value) => value.includes(base))).toEqual([])

    // A rename shows everywhere at once, once the board carries it; without one, the base name.
    await wrapper.setProps({ dwarf: defaultDwarf({ textDelivery: 'terminal', name: base }) })
    expect(wrapper.find('.dm-composer textarea').attributes('placeholder')).toBe(
      `Write to ${base}…`
    )
    expect(wrapper.attributes('aria-label')).toBe(`Chat with ${base}`)
    expect(named().filter((value) => value.includes('Gimli'))).toEqual([])
  })

  it('[US-MSG-001.AC12, US-MSG-002.AC09, US-MSG-001.AC13, US-MSG-002.AC08] the hint reads its designed line with drop files to attach, Send is labelled Send and Attach is named and titled Attach a file', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        textDelivery: 'terminal',
        capabilities: {
          sendText: 'terminal',
          cancel: 'terminal',
          adjustEffort: null,
          attach: 'terminal'
        }
      })
    })
    expect(wrapper.find('.dm-composer__hint').text()).toBe(DESIGN.hint)
    expect(wrapper.find('.dm-composer__send').text()).toBe(DESIGN.send)
    const attach = wrapper.find('.dm-composer__attach')
    expect(attach.attributes('aria-label')).toBe(DESIGN.attach)
    expect(attach.attributes('title')).toBe(DESIGN.attach)
  })

  it("[US-MSG-002.AC02, US-MSG-002.AC10] a chip's remove control is labelled Remove and the file name, and removes the file from the next send", async () => {
    const NOTES: DwarfAttachment = {
      path: 'C:\\work\\notes.txt',
      name: 'notes.txt',
      kind: 'file',
      bytes: 120
    }
    const picks: DwarfAttachmentPick[][] = [[{ path: NOTES.path, attachment: NOTES }]]
    ;(window as unknown as { api: unknown }).api = createFakeWindowApi({
      pathForDroppedFile: vi.fn((file: File) => `C:\\work\\${file.name}`),
      describeDwarfAttachments: vi.fn(() => Promise.resolve(picks.shift() ?? []))
    } as unknown as Partial<Window['api']>)
    const wrapper = panel({
      dwarf: defaultDwarf({
        textDelivery: 'terminal',
        capabilities: {
          sendText: 'terminal',
          cancel: 'terminal',
          adjustEffort: null,
          attach: 'terminal'
        }
      })
    })
    await wrapper
      .find('.dm-composer')
      .trigger('drop', { dataTransfer: { files: [new File(['x'], 'notes.txt')] } })
    await flushPromises()

    const remove = wrapper.find('.dm-composer__file button')
    expect(remove.attributes('aria-label')).toBe('Remove notes.txt')
    await remove.trigger('click')
    expect(wrapper.findAll('.dm-composer__file')).toHaveLength(0)
    await wrapper.find('.dm-composer textarea').setValue('just words')
    await wrapper.find('.dm-composer textarea').trigger('keydown', { key: 'Enter' })
    // The payload carries no attachments at all.
    expect(wrapper.emitted('send')).toEqual([[{ text: 'just words', pressEnter: true }]])
    delete (window as unknown as { api?: unknown }).api
  })

  it('[ADR-019] the composer is created with spellcheck off until S-019-3 and the design ruling are recorded', () => {
    // TC-257-03 of ISSUE-257, whose id is ADR-019.
    const box = panel().find('.dm-composer textarea').element
    // Off for the whole composer, which the well inherits (HTML `spellcheck` is inherited).
    expect(box.closest('[spellcheck]')?.getAttribute('spellcheck')).toBe('false')
  })
})

describe('MessagePanel log and bubbles (ISSUE-257)', () => {
  /** jsdom does no layout: a log as tall as the bubbles it holds, 40px each. */
  function layOut(list: Element): void {
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => list.querySelectorAll('.dm-bubble').length * 40
    })
    Object.defineProperty(list, 'clientHeight', { value: 30, configurable: true })
  }

  it('[US-MSG-001.AC09] the log is scrolled to the end when opened and when a message is added', async () => {
    const wrapper = panel()
    const list = wrapper.find('.dm-msg__log').element
    layOut(list)
    await wrapper.vm.$nextTick()
    await nextFrame()
    // Opened: at the end (two bubbles, 80px), never the top.
    expect(list.scrollTop).toBe(80)

    await wrapper.setProps({
      feed: heldFeed([...HELD, { role: 'assistant', text: 'Seam exhausted.', timestamp: 't2' }])
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(list.scrollTop).toBe(120)

    // The person's own message is added too: still at the end.
    await wrapper.setProps({ echoes: [echo({ id: 'e9' })] })
    await wrapper.vm.$nextTick()
    await nextFrame()
    expect(list.scrollTop).toBe(160)
  })

  it('[US-MSG-001.AC09] a message added while the reader had scrolled up still brings the log to its end', async () => {
    // Design screens/message.md (As built, Where the log starts): the log sets scrollTop to its
    // end "again after every message it adds" (foreman ruling 2026-10-17, new design wins).
    const wrapper = panel()
    const list = wrapper.find('.dm-msg__log').element
    layOut(list)
    await wrapper.vm.$nextTick()
    await nextFrame()
    list.scrollTop = 5 // 80 - 30 - 5 = 45: scrolled well up.

    await wrapper.setProps({
      feed: heldFeed([...HELD, { role: 'assistant', text: 'Seam exhausted.', timestamp: 't2' }])
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(list.scrollTop).toBe(120)

    // A tick changing on a bubble already there adds nothing, and moves nothing.
    await wrapper.setProps({ echoes: [echo({ id: 'e9' })] })
    await wrapper.vm.$nextTick()
    await nextFrame()
    list.scrollTop = 5
    await wrapper.setProps({ echoes: [echo({ id: 'e9', state: { phase: 'reacted' } })] })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(list.scrollTop).toBe(5)
  })

  it('[US-MSG-001.AC14] the first message of a day gets a TODAY divider', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 9, 17, 12, 0, 0))
      const today = (minutes: number) => new Date(2026, 9, 17, 9, minutes, 0).toISOString()
      const wrapper = panel({
        feed: heldFeed([
          { role: 'user', text: 'first of the day', timestamp: today(0) },
          { role: 'assistant', text: 'Found the seam.', timestamp: today(1) }
        ])
      })
      const log = wrapper.find('.dm-msg__log')
      const days = log.findAll('.dm-msg__day')
      expect(days.map((day) => day.text())).toEqual(['TODAY'])
      // Right above the day's first message.
      const next = days[0]!.element.nextElementSibling
      expect(next?.classList.contains('dm-bubble')).toBe(true)
      expect(next?.textContent).toContain('first of the day')
    } finally {
      vi.useRealTimers()
    }
  })

  it('[US-MSG-001.AC15, US-MSG-001.AC16] a sent bubble is named You and a message marked ✓✓ is titled Seen acting on it', () => {
    const reacted: DwarfSendState = { phase: 'reacted', via: 'terminal' }
    const wrapper = panel({ echoes: [echo({ state: reacted })] })
    const sent = wrapper.findAll('.dm-bubble--user').at(-1)!
    expect(sent.attributes('aria-label')).toBe('You')
    const mark = sent.find('.dm-bubble__mark')
    expect(mark.text()).toBe('✓✓')
    expect(mark.attributes('title')).toBe(DESIGN.seen)
    // The transcript's own ✓✓ says the same.
    const transcript = wrapper.findAll('.dm-bubble--user')[0]!.find('.dm-bubble__mark')
    expect(transcript.attributes('title')).toBe(DESIGN.seen)
  })

  it('[US-MSG-003.AC07, US-MSG-003.AC08] Retry and Copy read their labels and titles', () => {
    const wrapper = panel({ echoes: [echo({ state: { phase: 'failed', error: 'nope' } })] })
    const buttons = wrapper.findAll('.dm-bubble__actions .dm-btn')
    expect(buttons.map((b) => [b.text(), b.attributes('title')])).toEqual([
      DESIGN.retry,
      DESIGN.copy
    ])
    expect([RETRY_LABEL, RETRY_TITLE, COPY_LABEL, COPY_TITLE]).toEqual([
      ...DESIGN.retry,
      ...DESIGN.copy
    ])
  })

  it("[US-MSG-013.AC04, US-MSG-013.AC05] under a closed session the group heading still reads Not delivered and the composer's sentence reads the closed-session wording, distinct from the not-yet-supported one", () => {
    const closed = panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', status: 'leaving' }),
      echoes: [echo({ state: { phase: 'failed', error: 'nope' } })]
    })
    const group = closed.find('.dm-bubble__actions')
    expect(group.attributes('aria-label')).toBe(DESIGN.notDelivered)
    expect(group.findAll('.dm-btn').map((b) => b.text())).toEqual([DESIGN.copy[0]])
    const well = closed.find('.dm-composer textarea')
    expect(well.attributes('disabled')).toBeDefined()
    expect(well.attributes('placeholder')).toBe(DESIGN.closed)
    expect(SESSION_CLOSED_REASON).toBe(DESIGN.closed)

    // The other disabled reason, for a session type with no channel yet: never the closed one.
    const notYet = panel({ dwarf: defaultDwarf({ textDelivery: undefined }) })
    expect(NO_CHANNEL_REASON).toBe(DESIGN.noChannelYet)
    expect(notYet.find('.dm-composer textarea').attributes('placeholder')).not.toBe(DESIGN.closed)
    const notYetWell = notYet.find('.dm-composer textarea')
    const notYetSaid = [notYet.find('.dm-composer__hint').text(), notYetWell.attributes('title')]
    expect(notYetSaid).toContain(DESIGN.noChannelYet)
    expect(notYetSaid).not.toContain(DESIGN.closed)
  })
})
