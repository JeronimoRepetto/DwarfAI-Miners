// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { CONSOLE_HINT, JUMP_TO_TERMINAL_NAME } from '../../lib/delivery/actionBar'
import {
  PERMISSION_ESCAPED_LINE,
  PERMISSION_TYPED_LINE,
  PRESS_ENTER_TO_SEND
} from '../../lib/question/questionAnswer'
import { TYPED_HERE_REACHES_THE_PICKER, type DwarfPermissionRequest } from '../../types'
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
  return mount(DwarfPermissionCard, { props: { permission: permission(), ...props } })
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

describe('DwarfPermissionCard', () => {
  it('shows the tool name, the CLI’s own prompt sentence, and the redacted input', () => {
    const wrapper = card()
    expect(wrapper.find('.permission-header').text()).toBe('Bash')
    expect(wrapper.find('.permission-title').text()).toBe('Claude wants to run a command')
    expect(wrapper.find('.permission-input').text()).toBe('rm -rf /tmp/scratch')
    expect(wrapper.find('.permission-description').text()).toBe(
      'This command will run on your machine.'
    )
  })

  it('hides the title and description when the bridge supplied neither', () => {
    const wrapper = card({ permission: permission({ title: undefined, description: undefined }) })
    expect(wrapper.find('.permission-title').exists()).toBe(false)
    expect(wrapper.find('.permission-description').exists()).toBe(false)
  })

  it('lists Allow then Deny — Claude Code’s own fixed vocabulary, never the agent’s', () => {
    const labels = card()
      .findAll('.option-card .option-label')
      .map((node) => node.text())
    expect(labels).toEqual(['Allow', 'Deny'])
  })

  it('makes every choice a real button so the keyboard reaches it', () => {
    for (const option of card().findAll('.option-card')) {
      expect(option.element.tagName).toBe('BUTTON')
      expect(option.attributes('type')).toBe('button')
    }
  })

  it('draws every card in its base state before anything is chosen', () => {
    for (const option of card().findAll('.option-card')) {
      expect(option.classes()).toContain('is-base')
    }
  })

  it('marks the clicked option selected and dims the other, and asks for Enter', async () => {
    const wrapper = card()
    expect(wrapper.find('.enter-prompt').exists()).toBe(false)
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    const classes = wrapper.findAll('.option-card').map((option) => option.classes())
    expect(classes[0]).toContain('is-selected')
    expect(classes[1]).toContain('is-dimmed')
    expect(wrapper.find('.enter-prompt').text()).toBe(PRESS_ENTER_TO_SEND)
  })

  it('clears the selection when the selected card is clicked again', async () => {
    const wrapper = card()
    const allow = wrapper.findAll('.option-card')[0]!
    await allow.trigger('click')
    await allow.trigger('click')
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.classes()).toContain('is-base')
    }
  })

  it('does not decide on a mis-click alone — a destructive command must never fire on selection', async () => {
    const wrapper = card()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('emits "allow" when Allow is chosen and Enter confirms it', async () => {
    const wrapper = card()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    const event = pressEnter(wrapper.find('.permission-card').element)
    expect(wrapper.emitted('decide')).toEqual([['allow']])
    expect(event.defaultPrevented).toBe(true)
  })

  it('emits "deny" when Deny is chosen and Enter confirms it', async () => {
    const wrapper = card()
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    pressEnter(wrapper.find('.permission-card').element)
    expect(wrapper.emitted('decide')).toEqual([['deny']])
  })

  it('sends nothing on Enter while nothing is selected', () => {
    const wrapper = card()
    pressEnter(wrapper.find('.permission-card').element)
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('keeps Shift+Enter from confirming a selection', async () => {
    const wrapper = card()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    pressEnter(wrapper.find('.permission-card').element, true)
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('keeps a free-form reply available beside the two fixed answers', () => {
    const wrapper = card()
    expect(wrapper.find('.freeform-label').text()).toBe('Other Thing')
    expect(wrapper.find('.freeform-input').attributes('placeholder')).toBe('Write here...')
  })

  it('sends free-form text as a message and never as a decision', async () => {
    const wrapper = card()
    await wrapper.find('.freeform-input').setValue('let me check this first')
    pressEnter(wrapper.find('.freeform-input').element)
    expect(wrapper.emitted('send-text')).toEqual([
      [{ text: 'let me check this first', pressEnter: true }]
    ])
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('keeps Shift+Enter writing a newline in the free-form input', async () => {
    const wrapper = card()
    await wrapper.find('.freeform-input').setValue('one line')
    pressEnter(wrapper.find('.freeform-input').element, true)
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })

  it('disables every choice while a decision is in flight', async () => {
    const wrapper = card({ answerState: { phase: 'answering', toolUseId: 'toolu_09' } })
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.attributes('disabled')).toBeDefined()
    }
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('does not offer to decide a prompt that was already released', () => {
    const wrapper = card({ answerState: { phase: 'answered', toolUseId: 'toolu_09' } })
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.attributes('disabled')).toBeDefined()
    }
    pressEnter(wrapper.find('.permission-card').element)
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('re-enables the choices after a refusal and shows main’s reason', async () => {
    const wrapper = card({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_09',
        error: 'That prompt is no longer open.'
      }
    })
    expect(wrapper.find('.answer-error').text()).toBe('That prompt is no longer open.')
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    pressEnter(wrapper.find('.permission-card').element)
    expect(wrapper.emitted('decide')).toEqual([['allow']])
  })

  it('says the agent was handed the decision, never that it acted on the tool call', () => {
    const wrapper = card({ answerState: { phase: 'answered', toolUseId: 'toolu_09' } })
    expect(wrapper.find('.answer-ok').text()).toContain('released')
    expect(wrapper.find('.answer-ok').text()).not.toMatch(/reacted|ran|executed|acted/i)
  })

  it('shows a verdict only against the prompt it belongs to, never a later one', () => {
    const wrapper = card({
      permission: permission({ toolUseId: 'toolu_10' }),
      answerState: { phase: 'answered', toolUseId: 'toolu_09' }
    })
    expect(wrapper.find('.answer-ok').exists()).toBe(false)
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
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
    return mount(DwarfPermissionCard, { props: { permission: observed(), ...props } })
  }

  it('draws the prompt and both answers exactly as a held one', () => {
    const wrapper = terminalCard()
    expect(wrapper.find('.permission-header').text()).toBe('Bash')
    expect(wrapper.find('.permission-input').text()).toBe('rm -rf /tmp/scratch')
    expect(wrapper.findAll('.option-card .option-label').map((node) => node.text())).toEqual([
      'Allow',
      'Deny'
    ])
  })

  it('claims only that Allow was typed, never that the call was released', () => {
    // The held channel hands the decision to a stream this panel owns; this
    // one presses a key in a console it does not. Borrowing the stronger
    // sentence would be the ✓ claiming the ✓✓.
    const wrapper = terminalCard({
      answerState: { phase: 'answered', toolUseId: 'toolu_09', decision: 'allow' }
    })
    expect(wrapper.find('.answer-ok').text()).toBe(PERMISSION_TYPED_LINE)
    expect(wrapper.find('.answer-ok').text()).not.toContain('released')
  })

  it('warns after a Deny that a late Esc interrupts the turn instead', () => {
    const wrapper = terminalCard({
      answerState: { phase: 'answered', toolUseId: 'toolu_09', decision: 'deny' }
    })
    expect(wrapper.find('.answer-ok').text()).toBe(PERMISSION_ESCAPED_LINE)
  })

  it('offers the way to that terminal beside a refusal, since the prompt is still there', () => {
    const wrapper = terminalCard({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_09',
        decision: 'allow',
        error: 'Could not reach that terminal. Answer the prompt there.'
      }
    })
    expect(wrapper.find('.answer-error').text()).toContain(
      'Could not reach that terminal. Answer the prompt there.'
    )
    expect(wrapper.find('.answer-jump').text()).toBe(JUMP_TO_TERMINAL_NAME)
  })

  it('asks for that console when the jump is pressed', async () => {
    const wrapper = terminalCard({
      answerState: { phase: 'refused', toolUseId: 'toolu_09', error: 'nope' }
    })
    await wrapper.find('.answer-jump').trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
  })

  it('offers no jump for a held prompt, which has no second place to answer', () => {
    const wrapper = mount(DwarfPermissionCard, {
      props: {
        permission: permission(),
        answerState: { phase: 'refused', toolUseId: 'toolu_09', error: 'nope' }
      }
    })
    expect(wrapper.find('.answer-error').text()).toBe('nope')
    expect(wrapper.find('.answer-jump').exists()).toBe(false)
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
    expect(wrapper.find('.answer-error').exists()).toBe(false)
    expect(wrapper.findAll('.answer-jump')).toHaveLength(1)
  })

  /* --- The free-text box at an open dialog (#481) — one block, appended ---- */

  /*
   * The question card's stop-gap, on the prompt whose failure shape is the same
   * (#481). A permission dialog at a terminal is a y/n prompt, and free text
   * from this card leaves on the ordinary message path — which on this channel
   * writes into that session's own console, where the dialog reads the keys.
   */
  it('offers no free-text box, because the dialog there would read it', () => {
    const wrapper = terminalCard()
    expect(wrapper.find('.freeform-input').exists()).toBe(false)
    expect(wrapper.find('.freeform-refused').text()).toContain(TYPED_HERE_REACHES_THE_PICKER)
  })

  it('names the two ways out that do work, and no provider', () => {
    // The wire's sentence verbatim, exactly as the question card prints it: one
    // fact, one spelling, whichever card a person is looking at.
    const text = terminalCard().find('.freeform-refused').text()
    expect(text).toMatch(/picker/i)
    expect(text).toMatch(/terminal/i)
    expect(text).not.toMatch(/codex|claude|gemini/i)
  })

  it('offers the way to that terminal beside the refused box', async () => {
    const wrapper = terminalCard()
    const jump = wrapper.find('.freeform-refused .answer-jump')
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
    expect(wrapper.findAll('.answer-jump')).toHaveLength(1)
  })

  it('keeps the box on a held prompt, whose text touches no dialog', () => {
    const wrapper = card()
    expect(wrapper.find('.freeform-input').exists()).toBe(true)
    expect(wrapper.find('.freeform-refused').exists()).toBe(false)
  })

  it('sends nothing on the message path while the box is refused', async () => {
    const wrapper = terminalCard()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    pressEnter(wrapper.find('.permission-card').element)
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })
})
