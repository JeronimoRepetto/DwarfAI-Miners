// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { PRESS_ENTER_TO_SEND } from '../../lib/question/questionAnswer'
import type { DwarfPermissionRequest } from '../../types'
import DwarfPermissionCard from './DwarfPermissionCard.vue'

function permission(overrides: Partial<DwarfPermissionRequest> = {}): DwarfPermissionRequest {
  return {
    toolUseId: 'toolu_09',
    toolName: 'Bash',
    title: 'Claude wants to run a command',
    description: 'This command will run on your machine.',
    input: 'rm -rf /tmp/scratch',
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
