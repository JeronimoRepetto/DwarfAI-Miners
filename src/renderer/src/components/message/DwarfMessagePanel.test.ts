// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import {
  MESSAGE_PANEL_ASK_HEIGHT,
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

const LONG_REPLY = 'x'.repeat(1200)

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
    const worker2 = panel({ dwarf: defaultDwarf({ role: 'worker2', conversation: HELD }) })
    const foreman = panel({ dwarf: defaultDwarf({ role: 'foreman', conversation: HELD }) })
    expect(worker.find('.message.is-agent .portrait').attributes('src')).toContain('worker-face')
    expect(worker2.find('.message.is-agent .portrait').attributes('src')).toContain('worker2-face')
    expect(foreman.find('.message.is-agent .portrait').attributes('src')).toContain('foreman')
  })

  it('draws the launching agent against a prompt that agent issued', async () => {
    // #175: a worker's first message came from the foreman that spawned it, and
    // the panel was drawing the user's own face against it. The portrait is the
    // rank and the alt text is the name — the design draws no per-message
    // label, and inventing one is what `ui-rebuild` forbids.
    const wrapper = panel({
      dwarf: defaultDwarf({ role: 'worker', name: 'survey the seam', conversation: undefined }),
      feed: {
        readable: true,
        messages: [
          {
            role: 'user',
            text: 'survey the seam',
            timestamp: 't0',
            issuer: { role: 'foreman', name: 'coordinator' }
          },
          { role: 'assistant', text: 'On my way.', timestamp: 't1' }
        ]
      }
    })
    await wrapper.vm.$nextTick()

    const portraits = wrapper.findAll('.message .portrait')
    expect(portraits[0]!.attributes('src')).toContain('foreman')
    expect(portraits[0]!.attributes('alt')).toBe('coordinator, foreman')
    // The reply is still the dwarf speaking for itself.
    expect(portraits[1]!.attributes('src')).toContain('worker-face')
    expect(portraits[1]!.attributes('alt')).toBe('survey the seam, worker')
  })

  it("keeps the user's own face on a launch the human typed", async () => {
    // The other half of #175, and the case the design's launch flow draws: a
    // session the panel launched opens with the user's submitted prompt, and no
    // issuer is what says so.
    const wrapper = panel({
      dwarf: defaultDwarf({ role: 'foreman', name: 'coordinator', conversation: HELD })
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.message.is-user .portrait').attributes('alt')).toBe('You')
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
 * #195: the only scroll-to-bottom used to be `showLatest()`, fired on mount
 * and on the history tab expanding — never when the row list itself grew. A
 * newly-selected dwarf mounts before its feed comes back (App.vue's read is
 * async), so that mount-time call was a no-op against an empty list, and
 * nothing ran again once the feed prop landed on this same instance. These
 * tests pin the fix: a watch on the row list itself, applying
 * `lib/message/listScroll`'s pure verdict once new rows are actually in the
 * DOM.
 */
describe('DwarfMessagePanel scroll (#195)', () => {
  /**
   * jsdom does no layout, so `scrollHeight` is always 0 unless overridden. A
   * getter tied to the number of `.message` elements actually in the list lets
   * it grow the way a real list would once Vue patches new rows in — a static
   * value would report the SAME height before and after the patch, which is
   * exactly the distinction these tests exist to tell apart.
   */
  function growingScrollHeight(list: Element, perMessage = 40): void {
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: () => list.querySelectorAll('.message').length * perMessage
    })
  }

  function fixedClientHeight(list: Element, value: number): void {
    Object.defineProperty(list, 'clientHeight', { value, configurable: true })
  }

  it('scrolls to the newest message once a delayed read lands, even though the panel mounted with nothing to show', async () => {
    // The core of #195: a brand new dwarf mounts before its feed has come
    // back, so onMounted's own scroll-to-bottom is a no-op against an empty
    // list. App.vue keeps this same component instance once the feed lands
    // (see its own tests) rather than remounting, so nothing but a watch on
    // the rows themselves can still catch the moment they arrive.
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: undefined }), feed: undefined })
    const list = wrapper.find('.panel-conversation').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    expect(list.scrollTop).toBe(0)

    await wrapper.setProps({
      feed: {
        readable: true,
        messages: [
          { role: 'assistant', text: 'Found the seam.', timestamp: 't0' },
          { role: 'assistant', text: 'Halfway down the shaft.', timestamp: 't1' }
        ]
      }
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(80) // 2 rows * 40, the new bottom.
  })

  it('sticks to the bottom when a new row arrives and the reader was already there', async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: HELD }) })
    const list = wrapper.find('.panel-conversation').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    list.scrollTop = 50 // HELD has 2 rows: 80 - 30 - 50 = 0, exactly at the bottom.

    await wrapper.setProps({
      dwarf: defaultDwarf({
        conversation: [...HELD, { role: 'assistant', text: 'Seam exhausted.', timestamp: 't2' }]
      })
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(list.scrollTop).toBe(120) // 3 rows * 40, the new bottom.
  })

  it("keeps the reader's own scroll position when a row arrives below where they had scrolled up to", async () => {
    const wrapper = panel({ dwarf: defaultDwarf({ conversation: HELD }) })
    const list = wrapper.find('.panel-conversation').element
    growingScrollHeight(list)
    fixedClientHeight(list, 30)
    await wrapper.vm.$nextTick()
    list.scrollTop = 5 // 80 - 30 - 5 = 45, well past the tolerance: scrolled up.

    await wrapper.setProps({
      dwarf: defaultDwarf({
        conversation: [...HELD, { role: 'assistant', text: 'Seam exhausted.', timestamp: 't2' }]
      })
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // A row landed below the fold; a reader who had scrolled up must not be
    // yanked back down to read it (#195).
    expect(list.scrollTop).toBe(5)
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

  it('disables the box, saying the session has ended, for a dwarf that is leaving', () => {
    // #192: the channel the session HAD is still on the dwarf, frozen by the
    // grace window; the box must read the capability model, not the field.
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', status: 'leaving', conversation: HELD })
    })
    const input = wrapper.find('.panel-input')
    expect(input.attributes('disabled')).toBeDefined()
    expect(input.attributes('title')).toContain('ended')
    expect(wrapper.find('.panel-note').text()).toContain('ended')
  })

  it('names the channel a message would travel through', () => {
    const wrapper = panel({ dwarf: defaultDwarf({ textDelivery: 'foreman-relay' }) })
    expect(panel().find('.panel-input').attributes('title')).toContain('console')
    expect(wrapper.find('.panel-input').attributes('title')).toContain('foreman')
  })

  /*
   * #217. A control the panel disables says why IN the panel. Two dead
   * controls with nothing said is the "it looks broken" report this comes
   * from: the reason existed all along and lived only in a hover tooltip,
   * which is a refusal somebody has to go looking for.
   */
  it('says in the panel why the composer is disabled, not only on hover', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        provider: 'codex',
        capabilities: { sendText: null, cancel: 'launched-process', adjustEffort: null }
      })
    })
    expect(wrapper.find('.panel-input').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.panel-refusal').text()).toContain('codex exec')
    // The provenance note keeps its own row: what the panel may claim about a
    // transcript is a different fact from why a control is disabled.
    expect(wrapper.find('.panel-note').exists()).toBe(true)
  })

  it("shows the kick's refusal in the panel when the composer works and it does not", () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        provider: 'codex',
        textDelivery: 'codex-queue',
        capabilities: { sendText: 'codex-queue', cancel: null, adjustEffort: null }
      })
    })
    expect(wrapper.find('.panel-input').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.panel-refusal').text()).toContain('between turns')
  })

  it('draws no refusal row at all when both controls work', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        textDelivery: 'terminal',
        capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
      })
    })
    expect(wrapper.find('.panel-refusal').exists()).toBe(false)
  })

  it('lets a failure reason take the floor rather than doubling up with a refusal', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({ textDelivery: undefined }),
      sendState: { phase: 'failed', error: 'The relay never answered.' }
    })
    expect(wrapper.find('.panel-alert').text()).toBe('The relay never answered.')
    expect(wrapper.find('.panel-refusal').exists()).toBe(false)
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

  /*
   * Ending a session and interrupting a turn are different acts, and the person
   * must not be told the wrong one (#217).
   */
  it('says a kick ENDED the session where that is what it did', () => {
    const wrapper = panel({
      dwarf: defaultDwarf({
        provider: 'codex',
        capabilities: { sendText: null, cancel: 'launched-process', adjustEffort: null }
      }),
      kickState: { phase: 'delivered', via: 'launched-process' }
    })
    const line = wrapper.find('.panel-status').text()
    expect(line).toContain('Ended the session')
    expect(line).not.toContain('handed over')
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

  it('opens tall enough to hold the whole ask, without squashing the conversation', () => {
    expect(heightOf(asking())).toBe(MESSAGE_PANEL_ASK_HEIGHT)
  })

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
 * A permission prompt (#203): the tool call a held session is blocked inside
 * right now. It takes precedence over an ordinary ask, because it is the
 * thing keeping the session from moving at all — see the comment beside
 * `initialPanelHeight` in DwarfMessagePanel.vue.
 */
describe('DwarfMessagePanel permission (#203)', () => {
  const pendingPermission = {
    toolUseId: 'toolu_09',
    toolName: 'Bash',
    title: 'Claude wants to run a command',
    input: 'rm -rf /tmp/scratch',
    askedAt: '2026-09-05T09:00:00.000Z'
  }

  const pendingQuestion = {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }]
  }

  function withPermission(props: Record<string, unknown> = {}) {
    return panel({
      dwarf: defaultDwarf({ textDelivery: 'terminal', conversation: HELD, pendingPermission }),
      ...props
    })
  }

  it('opens tall enough to hold the whole prompt, without squashing the conversation', () => {
    expect(heightOf(withPermission())).toBe(MESSAGE_PANEL_ASK_HEIGHT)
  })

  it('replaces the composer with the permission card, exactly as an ask would', () => {
    const wrapper = withPermission()
    const composer = [...wrapper.find('.panel-composer').element.children]
    expect(composer[0]?.classList.contains('permission-card')).toBe(true)
    expect(wrapper.find('.panel-input').exists()).toBe(false)
    expect(wrapper.find('.panel-composer .control-kick').exists()).toBe(true)
  })

  it('forwards the chosen decision once Enter confirms it', async () => {
    const wrapper = withPermission()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.find('.permission-card').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('decide')).toEqual([['allow']])
  })

  it('shows the permission card, and not the question card, for a dwarf with both open', () => {
    // The session is blocked on the tool call, not on the ask: the permission
    // is the thing keeping it from moving, so it wins the composer. The ask
    // reappears once the permission is decided — main's next snapshot drops
    // it, not this component.
    const wrapper = panel({
      dwarf: defaultDwarf({
        textDelivery: 'terminal',
        conversation: HELD,
        pendingPermission,
        pendingQuestion
      })
    })
    expect(wrapper.find('.permission-card').exists()).toBe(true)
    expect(wrapper.find('.question-card').exists()).toBe(false)
  })

  it('routes a free-form reply through the ordinary message path, not the decision', async () => {
    const wrapper = withPermission()
    await wrapper.find('.freeform-input').setValue('let me check this first')
    await wrapper.find('.freeform-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toEqual([
      [{ text: 'let me check this first', pressEnter: true }]
    ])
    expect(wrapper.emitted('decide')).toBeUndefined()
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
