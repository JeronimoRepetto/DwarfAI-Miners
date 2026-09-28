// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { CONSOLE_HINT, JUMP_TO_TERMINAL_NAME } from '../../lib/delivery/actionBar'
import {
  PERMISSION_ESCAPED_LINE,
  PERMISSION_SENT_TO_OPENCODE_LINE,
  PERMISSION_TYPED_LINE,
  SUBMIT_ANSWERS_NAME
} from '../../lib/question/questionAnswer'
import {
  OTHER_PLACEHOLDER,
  OTHER_THING_LABEL,
  REQUEST_REGION_NAME,
  SEND_OTHER_NAME
} from '../../lib/question/questionCard'
import {
  OPENCODE_PERMISSION_ANSWERED_ABOVE,
  TYPED_HERE_REACHES_THE_PICKER,
  type DwarfPermissionRequest
} from '../../types'
import DwarfPermissionCard from './DwarfPermissionCard.vue'

function permission(overrides: Partial<DwarfPermissionRequest> = {}): DwarfPermissionRequest {
  return {
    toolUseId: 'toolu_09',
    toolName: 'Bash',
    title: 'Claude wants to run a command',
    description: 'This command will run on your machine.',
    input: 'rm -rf /tmp/scratch',
    channel: 'held',
    askedAt: '2026-09-05T09:00:00.000Z',
    ...overrides
  }
}

function card(props: Record<string, unknown> = {}) {
  return mount(DwarfPermissionCard, {
    props: { permission: permission(), name: 'codex-8', ...props },
    attachTo: document.body
  })
}

/** The Enter the design means: dispatched for real, so preventDefault is observable. */
function pressEnter(element: Element, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey,
    bubbles: true,
    cancelable: true
  })
  element.dispatchEvent(event)
  return event
}

/*
 * AMENDED for #635 (the permission card rebuilt as the question card with one step; was: a
 * sibling card with `.option-card` buttons in three states, a header, a title, an input block and
 * a description, and Enter confirming a selection). Every case below reads the design's card:
 * Allow and Deny are `.dm-qopt` rows whose `aria-checked` says which is picked, "Other thing…" is
 * the last row, the request is one code block, and the walk's Submit is the one send — Enter on
 * the card's only step does nothing (components.md, Question card, as built). Each case that
 * confirmed with Enter now presses Submit, and says so.
 */
type Card = VueWrapper

function options(wrapper: Card) {
  return wrapper.findAll('.dm-qopt:not(.dm-qopt--other)')
}

function checked(wrapper: Card): (string | undefined)[] {
  return options(wrapper).map((option) => option.attributes('aria-checked'))
}

function otherRow(wrapper: Card) {
  return wrapper.find('.dm-qopt--other')
}

function submitButton(wrapper: Card) {
  return wrapper.find('.dm-qcard__submit')
}

async function submit(wrapper: Card): Promise<void> {
  await submitButton(wrapper).trigger('click')
}

async function writeOther(wrapper: Card, text: string): Promise<void> {
  await otherRow(wrapper).trigger('click')
  await wrapper.find('.dm-qopt-other-field input').setValue(text)
}

describe('DwarfPermissionCard', () => {
  /*
   * AMENDED for #635 (was: the tool name, the title, the input and the description each in an
   * element of its own). The design sets the request in one block, the chat bubble's code block
   * (decision log, Permission request): the tool and its input, then the CLI's own sentences.
   */
  it('shows the tool name, the CLI’s own prompt sentence, and the redacted input', () => {
    const request = card().find('pre.dm-qcard__req')
    expect(request.text()).toBe(
      'Bash · rm -rf /tmp/scratch\nClaude wants to run a command\nThis command will run on your machine.'
    )
    expect(request.attributes('aria-label')).toBe(REQUEST_REGION_NAME)
    expect(request.attributes('tabindex')).toBe('0')
  })

  it('hides the title and description when the bridge supplied neither', () => {
    const wrapper = card({ permission: permission({ title: undefined, description: undefined }) })
    expect(wrapper.find('pre.dm-qcard__req').text()).toBe('Bash · rm -rf /tmp/scratch')
  })

  // AMENDED for #635 (was: `.option-card .option-label`): the design's rows, described by nothing.
  it('lists Allow then Deny — Claude Code’s own fixed vocabulary, never the agent’s', () => {
    const wrapper = card()
    expect(options(wrapper).map((o) => o.find('.dm-qopt__label').text())).toEqual(['Allow', 'Deny'])
    expect(wrapper.find('.dm-qopt__desc').exists()).toBe(false)
  })

  it('makes every choice a real button so the keyboard reaches it', () => {
    for (const option of options(card())) {
      expect(option.element.tagName).toBe('BUTTON')
      expect(option.attributes('type')).toBe('button')
    }
  })

  it('draws every card in its base state before anything is chosen', () => {
    expect(checked(card())).toEqual(['false', 'false'])
  })

  // AMENDED for #635 (was: the other dimmed, and "Press ENTER to send"): Submit wakes instead.
  it('marks the clicked option selected and wakes Submit', async () => {
    const wrapper = card()
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    await options(wrapper)[0]!.trigger('click')
    expect(checked(wrapper)).toEqual(['true', 'false'])
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('clears the selection when the selected card is clicked again', async () => {
    const wrapper = card()
    const allow = options(wrapper)[0]!
    await allow.trigger('click')
    await allow.trigger('click')
    expect(checked(wrapper)).toEqual(['false', 'false'])
  })

  it('does not decide on a mis-click alone — a destructive command must never fire on selection', async () => {
    const wrapper = card()
    await options(wrapper)[0]!.trigger('click')
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  // AMENDED for #635 (was: Enter confirmed it): Submit does, and Enter confirms nothing.
  it('emits "allow" when Allow is chosen and Submit confirms it', async () => {
    const wrapper = card()
    await options(wrapper)[0]!.trigger('click')
    pressEnter(wrapper.find('.dm-qcard').element)
    expect(wrapper.emitted('decide')).toBeUndefined()
    await submit(wrapper)
    expect(wrapper.emitted('decide')).toEqual([['allow']])
  })

  // AMENDED for #635 (was: Enter confirmed it).
  it('emits "deny" when Deny is chosen and Submit confirms it', async () => {
    const wrapper = card()
    await options(wrapper)[1]!.trigger('click')
    await submit(wrapper)
    expect(wrapper.emitted('decide')).toEqual([['deny']])
  })

  it('sends nothing on Enter while nothing is selected', () => {
    const wrapper = card()
    pressEnter(wrapper.find('.dm-qcard').element)
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  // AMENDED for #635 (was: Shift+Enter alone): no Enter confirms a selection, shifted or not.
  it('keeps Shift+Enter from confirming a selection', async () => {
    const wrapper = card()
    await options(wrapper)[0]!.trigger('click')
    pressEnter(options(wrapper)[0]!.element, true)
    pressEnter(options(wrapper)[0]!.element)
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  // AMENDED for #635 (was: an "Other Thing" label over an always-open "Write here..." box).
  it('keeps a free-form reply available beside the two fixed answers', async () => {
    const wrapper = card()
    expect(otherRow(wrapper).find('.dm-qopt__label').text()).toBe(OTHER_THING_LABEL)
    await otherRow(wrapper).trigger('click')
    expect(wrapper.find('.dm-qopt-other-field input').attributes('placeholder')).toBe(
      OTHER_PLACEHOLDER
    )
  })

  /*
   * AMENDED for #635 (was: Enter in the box sent it). Decision log, Permission free text: Submit
   * reads "Send" while "Other thing…" is picked, the words go as a plain message, and the card
   * stays — cleared, its first option focused — until Allow or Deny is submitted.
   */
  it('sends free-form text as a message and never as a decision', async () => {
    const wrapper = card()
    await writeOther(wrapper, 'let me check this first')
    expect(submitButton(wrapper).text()).toBe(SEND_OTHER_NAME)
    await submit(wrapper)
    expect(wrapper.emitted('send-text')).toEqual([
      [{ text: 'let me check this first', pressEnter: true }]
    ])
    expect(wrapper.emitted('decide')).toBeUndefined()
    expect(wrapper.find('.dm-qopt-other-field').exists()).toBe(false)
    expect(otherRow(wrapper).attributes('aria-checked')).toBe('false')
    expect(submitButton(wrapper).text()).toBe(SUBMIT_ANSWERS_NAME)
    expect(document.activeElement).toBe(options(wrapper)[0]!.element)
  })

  // AMENDED for #635 (was: Shift+Enter kept a newline): the field is one line and Enter in it,
  // on this card's only step, does nothing.
  it('keeps Enter in the free-form field from sending', async () => {
    const wrapper = card()
    await writeOther(wrapper, 'one line')
    pressEnter(wrapper.find('.dm-qopt-other-field input').element, true)
    pressEnter(wrapper.find('.dm-qopt-other-field input').element)
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })

  it('disables every choice while a decision is in flight', async () => {
    const wrapper = card({ answerState: { phase: 'answering', toolUseId: 'toolu_09' } })
    for (const option of options(wrapper)) {
      expect(option.attributes('disabled')).toBeDefined()
    }
    await options(wrapper)[0]!.trigger('click')
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('does not offer to decide a prompt that was already released', async () => {
    const wrapper = card({ answerState: { phase: 'answered', toolUseId: 'toolu_09' } })
    for (const option of options(wrapper)) {
      expect(option.attributes('disabled')).toBeDefined()
    }
    await submit(wrapper)
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('re-enables the choices after a refusal, drawing no alert', async () => {
    const wrapper = card({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_09',
        error: 'That prompt is no longer open.'
      }
    })
    // AMENDED for #635 (MESSAGE-QUESTIONS 21; was: main's reason in the card's alert row): the card draws no alert; the reason is the ✕ title on the "Answers:" record.
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
    for (const option of options(wrapper)) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
    await options(wrapper)[0]!.trigger('click')
    await submit(wrapper)
    expect(wrapper.emitted('decide')).toEqual([['allow']])
  })

  it('says the agent was handed the decision, never that it acted on the tool call', () => {
    const wrapper = card({ answerState: { phase: 'answered', toolUseId: 'toolu_09' } })
    expect(wrapper.find('.dm-qcard__ok').text()).toContain('released')
    expect(wrapper.find('.dm-qcard__ok').text()).not.toMatch(/reacted|ran|executed|acted/i)
  })

  it('shows a verdict only against the prompt it belongs to, never a later one', () => {
    const wrapper = card({
      permission: permission({ toolUseId: 'toolu_10' }),
      answerState: { phase: 'answered', toolUseId: 'toolu_09' }
    })
    expect(wrapper.find('.dm-qcard__ok').exists()).toBe(false)
    for (const option of options(wrapper)) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
  })

  // ADDED for #635: the Permission state as the design draws it (components.md, as built).
  it('reads "! asks", one step of one, with Back asleep, one dot, and no Next', () => {
    const wrapper = card()
    expect(wrapper.find('section.dm-qcard').attributes('aria-label')).toBe('codex-8 is asking')
    expect(wrapper.find('.dm-qcard__head .dm-pill__q').text()).toBe('!')
    expect(wrapper.find('.dm-qcard__step').text()).toBe('1 / 1')
    expect(wrapper.find('.dm-qcard__back').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('.dm-qcard__dots i')).toHaveLength(1)
    expect(wrapper.find('.dm-qcard__next').exists()).toBe(false)
    expect(submitButton(wrapper).classes()).toContain('dm-btn--primary')
    expect(wrapper.find('.dm-qcard__opts').attributes('aria-label')).toBe(
      wrapper.find('pre.dm-qcard__req').text()
    )
  })

  // ADDED for #635: keys 1 Allow, 2 Deny, 3 Other thing… (components.md, as built).
  it('picks Allow, Deny and Other thing… with 1, 2 and 3', async () => {
    const wrapper = card()
    const root = wrapper.find('.dm-qcard').element
    const key = (value: string) =>
      root.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
      )
    key('2')
    await wrapper.vm.$nextTick()
    expect(checked(wrapper)).toEqual(['false', 'true'])
    key('1')
    await wrapper.vm.$nextTick()
    expect(checked(wrapper)).toEqual(['true', 'false'])
    key('3')
    await wrapper.vm.$nextTick()
    expect(otherRow(wrapper).attributes('aria-checked')).toBe('true')
    expect(wrapper.emitted('decide')).toBeUndefined()
  })
})

/**
 * Issue #203. The same card, for a session the panel only OBSERVES: the tool
 * call is read off an unresolved `tool_use` in the transcript and the
 * decision is a keystroke into that session's own terminal.
 *
 * Identical to draw, deliberately — it is the same prompt, and a second card
 * would have been two components disagreeing about one thing. What differs is
 * only what may be claimed afterwards, and where a refusal leaves the person.
 */
describe('DwarfPermissionCard on the terminal channel (#203)', () => {
  const observed = (overrides: Partial<DwarfPermissionRequest> = {}) =>
    permission({ channel: 'terminal', ...overrides })

  function terminalCard(props: Record<string, unknown> = {}) {
    return mount(DwarfPermissionCard, {
      props: { permission: observed(), name: 'codex-8', ...props }
    })
  }

  // AMENDED for #635 (was: the header and the input block): the request block and the rows.
  it('draws the prompt and both answers exactly as a held one', () => {
    const wrapper = terminalCard()
    expect(wrapper.find('pre.dm-qcard__req').text()).toContain('Bash · rm -rf /tmp/scratch')
    expect(options(wrapper).map((o) => o.find('.dm-qopt__label').text())).toEqual(['Allow', 'Deny'])
  })

  it('claims only that Allow was typed, never that the call was released', () => {
    // The held channel hands the decision to a stream this panel owns; this
    // one presses a key in a console it does not. Borrowing the stronger
    // sentence would be the ✓ claiming the ✓✓.
    const wrapper = terminalCard({
      answerState: { phase: 'answered', toolUseId: 'toolu_09', decision: 'allow' }
    })
    expect(wrapper.find('.dm-qcard__ok').text()).toBe(PERMISSION_TYPED_LINE)
    expect(wrapper.find('.dm-qcard__ok').text()).not.toContain('released')
  })

  it('warns after a Deny that a late Esc interrupts the turn instead', () => {
    const wrapper = terminalCard({
      answerState: { phase: 'answered', toolUseId: 'toolu_09', decision: 'deny' }
    })
    expect(wrapper.find('.dm-qcard__ok').text()).toBe(PERMISSION_ESCAPED_LINE)
  })

  // AMENDED for #635 (was: the jump inside the refusal row): the walk's own Jump to terminal.
  it('offers the way to that terminal after a refusal, since the prompt is still there', () => {
    const wrapper = terminalCard({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_09',
        decision: 'allow',
        error: 'Could not reach that terminal. Answer the prompt there.'
      }
    })
    // AMENDED for #635 (MESSAGE-QUESTIONS 21; was: main's reason in the card's alert row): the card draws no alert; the reason is the ✕ title on the "Answers:" record.
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
    expect(wrapper.find('.dm-qcard__jump').text()).toBe(JUMP_TO_TERMINAL_NAME)
  })

  it('asks for that console when the jump is pressed', async () => {
    const wrapper = terminalCard({
      answerState: { phase: 'refused', toolUseId: 'toolu_09', error: 'nope' }
    })
    await wrapper.find('.dm-qcard__jump').trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
  })

  /*
   * AMENDED for #635 (was: 'offers no jump for a held prompt, which has no second place to
   * answer'). The design draws Jump to terminal in the walk of every state, the Permission state
   * included (components.md, Question card, as built); it does what the header's Open console
   * does for the same dwarf. The refusal row itself still carries no jump of its own.
   */
  it('offers the walk’s one jump on a held prompt too, and no refusal row', () => {
    const wrapper = mount(DwarfPermissionCard, {
      props: {
        permission: permission(),
        name: 'codex-8',
        answerState: { phase: 'refused', toolUseId: 'toolu_09', error: 'nope' }
      }
    })
    // AMENDED for #635 (MESSAGE-QUESTIONS 21; was: main's reason in the card's alert row): the card draws no alert; the reason is the ✕ title on the "Answers:" record.
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
    expect(wrapper.findAll('.dm-qcard__jump')).toHaveLength(1)
  })

  /*
   * AMENDED for #481 (was: 'offers no jump while a decision stands, only where
   * one was refused', asserting `.answer-jump` absent ANYWHERE on the card).
   * The refused free-text box carries a jump of its own on this channel now, so
   * "none at all" is no longer the fact. What this pins is the rule it was
   * written for plus the one #481 added: the REFUSAL row offers none while a
   * decision stands, and the card never shows two ways to one console.
   */
  it('offers no refusal jump while a decision stands, and never two jumps', () => {
    const wrapper = terminalCard({
      answerState: { phase: 'answered', toolUseId: 'toolu_09', decision: 'allow' }
    })
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
    expect(wrapper.findAll('.dm-qcard__jump')).toHaveLength(1)
  })

  /* --- The free-text box at an open dialog (#481) — one block, appended ---- */

  /*
   * The question card's stop-gap, on the prompt whose failure shape is the same
   * (#481). A permission dialog at a terminal is a y/n prompt, and free text
   * from this card leaves on the ordinary message path — which on this channel
   * writes into that session's own console, where the dialog reads the keys.
   * AMENDED for #635 (was: no `.freeform-input`): the "Other thing…" row is drawn, closed, and
   * the sentence stands where its field would open.
   */
  it('offers no free-text box, because the dialog there would read it', async () => {
    const wrapper = terminalCard()
    expect(otherRow(wrapper).attributes('disabled')).toBeDefined()
    await otherRow(wrapper).trigger('click')
    expect(wrapper.find('.dm-qopt-other-field').exists()).toBe(false)
    expect(wrapper.find('.dm-qcard__closed').text()).toContain(TYPED_HERE_REACHES_THE_PICKER)
  })

  it('names the two ways out that do work, and no provider', () => {
    // The wire's sentence verbatim, exactly as the question card prints it: one
    // fact, one spelling, whichever card a person is looking at.
    const text = terminalCard().find('.dm-qcard__closed').text()
    expect(text).toMatch(/picker/i)
    expect(text).toMatch(/terminal/i)
    expect(text).not.toMatch(/codex|claude|gemini/i)
  })

  // AMENDED for #635 (was: the jump inside `.freeform-refused`): the walk's one jump.
  it('offers the way to that terminal beside the refused box', async () => {
    const wrapper = terminalCard()
    const jump = wrapper.find('.dm-qcard__jump')
    expect(jump.text()).toBe(JUMP_TO_TERMINAL_NAME)
    expect(jump.attributes('title')).toBe(CONSOLE_HINT)
    await jump.trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
  })

  it('offers exactly one jump once a decision has been refused as well', () => {
    // The refusal row below already carries the way to that console, and one
    // affordance must not read as two.
    const wrapper = terminalCard({
      answerState: { phase: 'refused', toolUseId: 'toolu_09', error: 'nope' }
    })
    expect(wrapper.findAll('.dm-qcard__jump')).toHaveLength(1)
  })

  it('keeps the box on a held prompt, whose text touches no dialog', () => {
    const wrapper = card()
    expect(otherRow(wrapper).attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.dm-qcard__closed').exists()).toBe(false)
  })

  // AMENDED for #635 (was: Enter confirmed): Submit.
  it('sends nothing on the message path while the box is refused', async () => {
    const wrapper = terminalCard()
    await options(wrapper)[0]!.trigger('click')
    await submit(wrapper)
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })
})

/**
 * Issue #588 T5. The same card, for an OpenCode session's own permission
 * dialog: the decision is answered over OpenCode's own HTTP server rather
 * than a console, so this channel must NOT draw the terminal channel's
 * console-shaped copy or its Jump-to-terminal button — that was review
 * finding F2, and closing it is the point of this slice.
 */
describe('DwarfPermissionCard on the opencode-permission channel (#588 T5)', () => {
  const opencode = (overrides: Partial<DwarfPermissionRequest> = {}) =>
    permission({ channel: 'opencode-permission', ...overrides })

  function opencodeCard(props: Record<string, unknown> = {}) {
    return mount(DwarfPermissionCard, {
      props: { permission: opencode(), name: 'codex-8', ...props }
    })
  }

  // AMENDED for #635 (was: the header): the request block and the rows.
  it('draws the prompt and both answers exactly as a held one', () => {
    const wrapper = opencodeCard()
    expect(wrapper.find('pre.dm-qcard__req').text()).toContain('Bash · ')
    expect(options(wrapper).map((o) => o.find('.dm-qopt__label').text())).toEqual(['Allow', 'Deny'])
  })

  it('draws both choices enabled, because this channel genuinely answers now', () => {
    // The bug F2 names: the card used to draw enabled buttons on the
    // 'terminal' channel that failed AFTER the click. Enabled is honest here
    // because runtime.ts's answerDwarfPermission now really POSTs this
    // decision — see answerOpenCodePermissionDialog.
    for (const option of options(opencodeCard())) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
  })

  // AMENDED for #635 (was: Enter confirmed): Submit.
  it('emits "allow" and "deny" exactly as every other channel does', async () => {
    const allowWrapper = opencodeCard()
    await options(allowWrapper)[0]!.trigger('click')
    await submit(allowWrapper)
    expect(allowWrapper.emitted('decide')).toEqual([['allow']])

    const denyWrapper = opencodeCard()
    await options(denyWrapper)[1]!.trigger('click')
    await submit(denyWrapper)
    expect(denyWrapper.emitted('decide')).toEqual([['deny']])
  })

  it('says OpenCode was sent the decision, never that the call was released or typed at a terminal', () => {
    const wrapper = opencodeCard({
      answerState: { phase: 'answered', toolUseId: 'toolu_09', decision: 'allow' }
    })
    expect(wrapper.find('.dm-qcard__ok').text()).toBe(PERMISSION_SENT_TO_OPENCODE_LINE)
    expect(wrapper.find('.dm-qcard__ok').text()).not.toMatch(/released|typed at the terminal/i)
  })

  it('says the same thing for a Deny, since OpenCode’s own "reject" carries no second meaning', () => {
    const wrapper = opencodeCard({
      answerState: { phase: 'answered', toolUseId: 'toolu_09', decision: 'deny' }
    })
    expect(wrapper.find('.dm-qcard__ok').text()).toBe(PERMISSION_SENT_TO_OPENCODE_LINE)
    expect(wrapper.find('.dm-qcard__ok').text()).not.toBe(PERMISSION_ESCAPED_LINE)
  })

  it('draws no refusal row on a failed POST, and no Jump button — there is no terminal to jump to', () => {
    const wrapper = opencodeCard({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_09',
        decision: 'allow',
        error: "Could not reach OpenCode's own server. The session may have been closed."
      }
    })
    // AMENDED for #635 (MESSAGE-QUESTIONS 21; was: main's reason in the card's alert row): the card draws no alert; the reason is the ✕ title on the "Answers:" record.
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
    expect(wrapper.find('.dm-qcard__jump').exists()).toBe(false)
  })

  // AMENDED for #635 (was: no `.freeform-input`): the row is drawn closed, with OpenCode's reason.
  it('offers no free-text box, and says why in OpenCode’s own terms — never the picker/terminal wording', () => {
    const wrapper = opencodeCard()
    expect(otherRow(wrapper).attributes('disabled')).toBeDefined()
    const text = wrapper.find('.dm-qcard__closed').text()
    expect(text).toBe(OPENCODE_PERMISSION_ANSWERED_ABOVE)
    expect(text).not.toBe(TYPED_HERE_REACHES_THE_PICKER)
    expect(text).not.toMatch(/picker|terminal/i)
  })

  it('offers no jump anywhere on the card — there is no console this channel could open', () => {
    const wrapper = opencodeCard({
      answerState: { phase: 'refused', toolUseId: 'toolu_09', error: 'nope' }
    })
    expect(wrapper.findAll('.dm-qcard__jump')).toHaveLength(0)
  })
})

/*
 * ADDED for #635: an input method's own Enter picks its candidate, and the text it belongs to is
 * not written yet — the composer's rule (belongsToComposition, lib/controls/input), which the
 * free-answer box ignored.
 */
describe('DwarfPermissionCard and an Enter that belongs to an IME composition', () => {
  // AMENDED for #635 (was: the old always-open box): the field "Other thing…" opens.
  it('sends nothing from the free-answer box while the composition is open', async () => {
    const wrapper = card()
    await writeOther(wrapper, 'にほんご')
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      wrapper
        .find('.dm-qopt-other-field input')
        .element.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
        )
    }
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })
})
