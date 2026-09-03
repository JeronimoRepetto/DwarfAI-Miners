// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import {
  MESSAGE_PANEL_MAX_HEIGHT,
  MESSAGE_PANEL_MIN_HEIGHT,
  initialPanelHeight
} from '../../lib/message/panelHeight'
import { NO_TRANSCRIPT_NOTE, READING_NOTE } from '../../lib/message/conversation'
import { defaultDwarf } from '../../testing/factories'
import { MAX_DWARF_TEXT_CHARS } from '../../types'
import DwarfMessagePanel from './DwarfMessagePanel.vue'

/*
 * WHERE DwarfActionBar's TESTS WENT (#159).
 *
 * The interim icon bar (#27) died here and this file is where its behaviours
 * are now pinned: the console action, Escape, the whole send path (Enter,
 * Shift+Enter, the blank refusal, the char cap, the channel hint, the in-flight
 * lock, the two-phase verdict), the whole kick path (arm-then-fire, the
 * channel-specific refusals, the in-flight lock, the verdict) and Boost's
 * disabled reason with its per-provider effort label.
 *
 * Three of its behaviours went with the bar rather than moving, and none of
 * them silently:
 *
 * - **The `pressEnter` checkbox** ("Press Enter in the session") and its test.
 *   `screens/mine.md` says Enter sends and the panel it draws carries no second
 *   control to say otherwise, so a message now always arrives with the
 *   session's own Enter. A console-delivered line can no longer be typed
 *   without submitting it.
 * - **The chat toggle** and its two tests (hide until clicked, collapse on a
 *   second click). The design's panel has no toggle: the input is the surface.
 * - **The disarm-on-chat-open test**, whose gesture no longer exists. A
 *   half-confirmed kick is still cleared when the panel moves to another
 *   dwarf, which is the case that survived.
 *
 * The bar's four shape tests (icon order, inline pixel art, aria-labels, the
 * hover tooltip) described a surface that no longer exists; this file's own
 * shape tests describe the one that replaced it. `lib/delivery/actionBar.ts`
 * and its tests are untouched — the capability model outlived the component
 * that rendered it, and the panel reads the same entries.
 */

const LONG_REPLY = 'x'.repeat(600)

const HELD = [
  { role: 'user' as const, text: 'dig here', timestamp: '2026-09-03T09:00:00.000Z' },
  { role: 'assistant' as const, text: 'Found the seam.', timestamp: '2026-09-03T09:00:01.000Z' }
]

function panel(props: Record<string, unknown> = {}) {
  return mount(DwarfMessagePanel, {
    props: {
      dwarf: defaultDwarf({ textDelivery: 'terminal', conversation: HELD }),
      ...props
    }
  })
}

/**
 * A pointer gesture on the resize handle.
 *
 * Dispatched rather than triggered: `clientY` is a getter on jsdom's
 * MouseEvent, so test-utils' own `trigger(type, { clientY })` cannot set it —
 * the constructor is the only way in. `pointerId` is deliberately absent,
 * which is also what jsdom gives a real listener here.
 */
function pointer(wrapper: ReturnType<typeof panel>, type: string, clientY: number, clientX = 0) {
  wrapper
    .find('.panel-resize')
    .element.dispatchEvent(new MouseEvent(type, { clientY, clientX, bubbles: true }))
  return wrapper.vm.$nextTick()
}

/** The panel's own height, as the style attribute carries it. */
function heightOf(wrapper: ReturnType<typeof panel>): number {
  const style = wrapper.find('.message-panel').attributes('style') ?? ''
  return Number(/height:\s*([\d.]+)px/.exec(style)?.[1] ?? '0')
}

describe('DwarfMessagePanel shape', () => {
  it('names the selected dwarf, as the design puts it at the top left', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ name: 'Durin', conversation: HELD }) })
    expect(wrapper.find('.panel-agent').text()).toBe('Durin')
  })

  it("draws the dwarf's own portrait beside what it said", () => {
    const worker = panel({ dwarf: defaultDwarf({ role: 'worker', conversation: HELD }) })
    const foreman = panel({ dwarf: defaultDwarf({ role: 'foreman', conversation: HELD }) })
    expect(worker.find('.message.is-agent .portrait').attributes('src')).toContain('worker')
    expect(foreman.find('.message.is-agent .portrait').attributes('src')).toContain('foreman')
  })

  it('start-aligns the agent and end-aligns the user, as the design does', () => {
    const messages = panel().findAll('.message')
    expect(messages[0]!.classes()).toContain('is-user')
    expect(messages[1]!.classes()).toContain('is-agent')
  })

  it('centres the history tab between the name and the close, as the design does', () => {
    const bar = [...panel().find('.panel-bar').element.children]
    expect(bar.map((child) => child.className)).toEqual([
      'panel-agent',
      'panel-history',
      'panel-close'
    ])
  })

  it('carries the three controls the design draws: kick, boost and close', () => {
    const wrapper = panel()
    expect(wrapper.find('.control-kick').exists()).toBe(true)
    expect(wrapper.find('.control-boost').exists()).toBe(true)
    expect(wrapper.find('.panel-close').exists()).toBe(true)
  })

  it('gives the messages their own scroll, so history reads without expanding anything', () => {
    expect(panel().find('.panel-conversation').exists()).toBe(true)
  })

  it('opens showing the latest message rather than the oldest', async () => {
    // Oldest first is the design's order, so an unscrolled panel would open on
    // the message furthest from what just happened.
    const wrapper = panel()
    const list = wrapper.find('.panel-conversation').element
    Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(list.scrollTop).toBe(900)
  })
})

/**
 * Every sizing rule `screens/mine.md` states, in its own words: the initial
 * height derives from the latest message, new messages never resize the panel,
 * reopening recalculates, and the user may resize it vertically only.
 */
describe('DwarfMessagePanel height', () => {
  it("opens at the height its dwarf's latest message calls for", () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        conversation: [{ role: 'assistant', text: LONG_REPLY, timestamp: 'now' }]
      })
    })
    expect(heightOf(wrapper)).toBe(initialPanelHeight(LONG_REPLY))
    expect(heightOf(wrapper)).toBeGreaterThan(MESSAGE_PANEL_MIN_HEIGHT)
  })

  it('never resizes itself when a new message arrives', async () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ conversation: [{ role: 'assistant', text: 'ok', timestamp: 'now' }] })
    })
    const opened = heightOf(wrapper)

    await wrapper.setProps({
      dwarf: defaultDwarf({
        conversation: [
          { role: 'assistant', text: 'ok', timestamp: 'now' },
          { role: 'assistant', text: LONG_REPLY, timestamp: 'later' }
        ]
      })
    })

    expect(heightOf(wrapper)).toBe(opened)
  })

  it('recalculates from the latest message when it is closed and opened again', () => {
    // The panel is mounted per selection, so "reopening" is a fresh mount —
    // which is the whole reason the height rule is a pure function.
    const short = panel({
      dwarf: defaultDwarf({ conversation: [{ role: 'assistant', text: 'ok', timestamp: 'now' }] })
    })
    const long = panel({
      dwarf: defaultDwarf({
        conversation: [{ role: 'assistant', text: LONG_REPLY, timestamp: 'now' }]
      })
    })
    expect(heightOf(long)).toBeGreaterThan(heightOf(short))
  })

  it('resizes vertically from the drag handle, and only vertically', async () => {
    const wrapper = panel()
    const opened = heightOf(wrapper)

    await pointer(wrapper, 'pointerdown', 400, 100)
    await pointer(wrapper, 'pointermove', 330, 900)

    // Dragging the top edge UP makes a bottom-docked panel taller.
    expect(heightOf(wrapper)).toBe(opened + 70)
    // Nothing the pointer did sideways reached the panel: there is no width to set.
    expect(wrapper.find('.message-panel').attributes('style')).not.toContain('width:')
  })

  it('stops the drag at the floor and at the ceiling', async () => {
    const wrapper = panel()

    await pointer(wrapper, 'pointerdown', 400)
    await pointer(wrapper, 'pointermove', 4000)
    expect(heightOf(wrapper)).toBe(MESSAGE_PANEL_MIN_HEIGHT)

    await pointer(wrapper, 'pointermove', -4000)
    expect(heightOf(wrapper)).toBe(MESSAGE_PANEL_MAX_HEIGHT)
  })

  it('ignores a pointer that moved without ever grabbing the handle', async () => {
    const wrapper = panel()
    const opened = heightOf(wrapper)
    await pointer(wrapper, 'pointermove', 100)
    expect(heightOf(wrapper)).toBe(opened)
  })

  it('resizes from the keyboard too, because a drag handle is not reachable without one', async () => {
    const wrapper = panel()
    const opened = heightOf(wrapper)
    await wrapper.find('.panel-resize').trigger('keydown', { key: 'ArrowUp' })
    expect(heightOf(wrapper)).toBeGreaterThan(opened)
    await wrapper.find('.panel-resize').trigger('keydown', { key: 'ArrowDown' })
    expect(heightOf(wrapper)).toBe(opened)
  })
})

describe('DwarfMessagePanel history tab', () => {
  it('starts collapsed and expands to the full transcript', async () => {
    const wrapper = panel()
    expect(wrapper.find('.panel-history').attributes('aria-expanded')).toBe('false')

    await wrapper.find('.panel-history').trigger('click')
    expect(wrapper.find('.panel-history').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.message-panel').classes()).toContain('is-history')
    expect(heightOf(wrapper)).toBe(MESSAGE_PANEL_MAX_HEIGHT)
  })

  it('gives the height back exactly as it was when the history closes again', async () => {
    const wrapper = panel()
    const opened = heightOf(wrapper)
    await wrapper.find('.panel-history').trigger('click')
    await wrapper.find('.panel-history').trigger('click')
    expect(heightOf(wrapper)).toBe(opened)
  })

  it('draws a portrait against every message in the transcript, both sides', async () => {
    const wrapper = panel()
    await wrapper.find('.panel-history').trigger('click')
    expect(wrapper.findAll('.message .portrait')).toHaveLength(2)
  })
})

describe('DwarfMessagePanel input', () => {
  it('sends on Enter and writes a newline on Shift+Enter', async () => {
    const wrapper = panel()
    await wrapper.find('.panel-input').setValue('dig deeper')

    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()

    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([[{ text: 'dig deeper', pressEnter: true }]])
  })

  it('clears the box once the message has left', async () => {
    const wrapper = panel()
    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    expect((wrapper.find('.panel-input').element as HTMLTextAreaElement).value).toBe('')
  })

  it('refuses to send a blank message', async () => {
    const wrapper = panel()
    await wrapper.find('.panel-input').setValue('   ')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('sends nothing while a send is still in flight', async () => {
    const wrapper = panel({ sendState: { phase: 'sending' } })
    await wrapper.find('.panel-input').setValue('dig deeper')
    await wrapper.find('.panel-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('caps the message at the shared delivery limit', () => {
    expect(panel().find('.panel-input').attributes('maxlength')).toBe(String(MAX_DWARF_TEXT_CHARS))
  })

  it('keeps the input selectable, which the design asks for by name', () => {
    // Guarded here because it is a stated rule that a stylesheet change could
    // silently take away.
    expect(panel().find('.panel-input').classes()).toContain('is-selectable')
  })

  it('disables the box, with its reason, for a session that cannot be written to', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: undefined }) })
    const input = wrapper.find('.panel-input')
    expect(input.attributes('disabled')).toBeDefined()
    expect(input.attributes('title')).toContain("can't receive messages yet")
  })

  it('names the channel a message would travel through', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: 'foreman-relay' }) })
    expect(panel().find('.panel-input').attributes('title')).toContain('console')
    expect(wrapper.find('.panel-input').attributes('title')).toContain('foreman')
  })

  it('shows the send verdict without ever blurring handed over and reacted', () => {
    const handed = panel({
      sendState: { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    })
    expect(handed.find('.panel-status').text()).toContain('Handed over')
    expect(handed.find('.panel-status').text()).not.toContain('reacted.')

    const reacted = panel({ sendState: { phase: 'reacted', via: 'terminal' } })
    expect(reacted.find('.panel-status').text()).toContain('the session reacted')

    const failed = panel({ sendState: { phase: 'failed', error: 'The relay never answered.' } })
    expect(failed.find('.panel-alert').text()).toBe('The relay never answered.')
  })
})

describe('DwarfMessagePanel controls', () => {
  const kickable = defaultDwarf({
    textDelivery: 'terminal',
    conversation: HELD,
    capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
  })

  it('asks for a second click before it kicks', async () => {
    const wrapper = panel({ dwarf: kickable })
    await wrapper.find('.control-kick').trigger('click')
    expect(wrapper.emitted('kick')).toBeUndefined()
    expect(wrapper.find('.control-kick').classes()).toContain('is-armed')

    await wrapper.find('.control-kick').trigger('click')
    expect(wrapper.emitted('kick')).toHaveLength(1)
    expect(wrapper.find('.control-kick').classes()).not.toContain('is-armed')
  })

  it('disables kick, with the reason, when the session cannot be cancelled', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ capabilities: { sendText: null, cancel: null, adjustEffort: null } })
    })
    expect(wrapper.find('.control-kick').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.control-kick').attributes('title')).toContain("can't be canceled yet")
  })

  it('disables kick when the dwarf carries no capability matrix at all', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ capabilities: undefined }) })
    expect(wrapper.find('.control-kick').attributes('disabled')).toBeDefined()
  })

  it('names what kicking THIS channel actually does, rather than one generic promise', () => {
    const relay = panel({
      dwarf: defaultDwarf({
        capabilities: { sendText: 'claude-relay', cancel: 'claude-relay', adjustEffort: null }
      })
    })
    expect(relay.find('.control-kick').attributes('title')).toBe(
      'Asks the agent to stop — it decides how.'
    )
  })

  it('locks the kick control while a kick is in flight', async () => {
    const wrapper = panel({ dwarf: kickable, kickState: { phase: 'kicking' } })
    const control = wrapper.find('.control-kick')
    expect(control.attributes('disabled')).toBeDefined()
    expect(control.attributes('aria-label')).toBe('Kicking...')
    await control.trigger('click')
    expect(wrapper.emitted('kick')).toBeUndefined()
  })

  it('shows the kick verdict, keeping handed over apart from reacted', () => {
    const wrapper = panel({
      dwarf: kickable,
      kickState: { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    })
    expect(wrapper.find('.panel-status').text()).toContain('Kick handed over')
  })

  it('draws Boost where the design puts it and refuses to pretend it works', () => {
    // The spike found `applyFlagSettings` resolves as a silent no-op with no
    // supportsEffort guard, and no provider here exposes an effort channel at
    // all — so the control is rendered and disabled with its reason, never
    // wired to something that would answer a click with silence.
    const wrapper = panel({ dwarf: defaultDwarf({ provider: 'claude', effort: 'xhigh' }) })
    const boost = wrapper.find('.control-boost')
    expect(boost.attributes('disabled')).toBeDefined()
    expect(boost.attributes('title')).toContain(
      "No provider supports changing a running session's effort yet."
    )
    expect(boost.attributes('title')).toContain('Extra high')
  })

  it('passes a Codex reasoning_effort value through as it was reported', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ provider: 'codex', effort: 'medium' }) })
    expect(wrapper.find('.control-boost').attributes('title')).toContain('medium')
  })

  it('closes on the close control and on Escape', async () => {
    const wrapper = panel()
    await wrapper.find('.panel-close').trigger('click')
    await wrapper.find('.message-panel').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it("focuses the session's console from the dwarf's own name", async () => {
    // Where the old action bar's console icon went: the design draws a name
    // here and no fourth icon, so the name is the control.
    const wrapper = panel()
    await wrapper.find('.panel-agent').trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
  })
})

/**
 * The question card, re-homed (#128, #159). Its own behaviours are its own
 * tests; what belongs here is that the panel gives it the designed place —
 * above the input — and forwards both of its channels unchanged.
 */
describe('DwarfMessagePanel question', () => {
  const pendingQuestion = {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }]
  }

  function asking(props: Record<string, unknown> = {}) {
    return panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', conversation: HELD, pendingQuestion }),
      ...props
    })
  }

  it('shows no question surface for a dwarf with nothing outstanding', () => {
    expect(panel().find('.question-card').exists()).toBe(false)
  })

  it('replaces the composer with the ask, exactly as the design draws it', () => {
    // The two question exports show the option cards and the card's own
    // `Other Thing` box where the ordinary input sits — one input, not two.
    const wrapper = asking()
    const composer = [...wrapper.find('.panel-composer').element.children]
    expect(composer[0]?.classList.contains('question-card')).toBe(true)
    expect(wrapper.find('.panel-input').exists()).toBe(false)
    // The two controls stay beside it, where every export puts them.
    expect(wrapper.find('.panel-composer .control-kick').exists()).toBe(true)
  })

  it('forwards the chosen option once Enter confirms it', async () => {
    const wrapper = asking()
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    await wrapper.find('.question-card').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('answer')).toEqual([['SQLite']])
  })

  it('routes a free-form reply through the ordinary message path, not the ask', async () => {
    const wrapper = asking()
    await wrapper.find('.freeform-input').setValue('neither, keep the file store')
    await wrapper.find('.freeform-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([
      [{ text: 'neither, keep the file store', pressEnter: true }]
    ])
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it("hands main's refusal down to the card so the panel can explain itself", () => {
    const wrapper = asking({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_01',
        error: 'That session is not one this panel is holding.'
      }
    })
    expect(wrapper.find('.answer-error').text()).toBe(
      'That session is not one this panel is holding.'
    )
  })
})

/**
 * What each session type may honestly show. The resolution itself is
 * lib/message/conversation's; what is checked here is that the panel prints
 * the claim rather than dropping it, and never invents a bubble.
 */
describe('DwarfMessagePanel honesty', () => {
  it("says a held session's exchange is the one this panel watched happen", () => {
    expect(panel().find('.panel-note').text()).toContain('holding this session')
  })

  it("says an observed session's messages are its latest activity", () => {
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: {
        readable: true,
        messages: [{ role: 'assistant', text: 'Blasting', timestamp: 'now' }]
      }
    })
    expect(wrapper.find('.panel-note').text()).toContain('Latest activity')
    expect(wrapper.findAll('.message')).toHaveLength(1)
  })

  it('draws an empty state, never a bubble, for a session it cannot read', () => {
    const wrapper = panel({
      dwarf: defaultDwarf(),
      feed: { readable: false, messages: [] }
    })
    expect(wrapper.findAll('.message')).toHaveLength(0)
    expect(wrapper.find('.panel-empty').text()).toBe(NO_TRANSCRIPT_NOTE)
  })

  it('says it is still reading rather than that there is nothing', () => {
    const wrapper = panel({ dwarf: defaultDwarf() })
    expect(wrapper.find('.panel-empty').text()).toBe(READING_NOTE)
  })
})
