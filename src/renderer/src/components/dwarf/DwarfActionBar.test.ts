// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import { MAX_DWARF_TEXT_CHARS } from '../../types'
import DwarfActionBar from './DwarfActionBar.vue'

function bar(props: Record<string, unknown> = {}) {
  return mount(DwarfActionBar, {
    props: { dwarf: defaultDwarf({ textDelivery: 'terminal' }), ...props }
  })
}

describe('DwarfActionBar', () => {
  it('lines up the four action icons in order: kick, boost, chat, console', () => {
    const buttons = bar().findAll('.icon-row button')
    expect(buttons.map((b) => b.classes())).toEqual([
      expect.arrayContaining(['icon-kick']),
      expect.arrayContaining(['icon-boost']),
      expect.arrayContaining(['icon-chat']),
      expect.arrayContaining(['icon-console'])
    ])
  })

  it('draws each icon as inline pixel art instead of text or emoji', () => {
    for (const button of bar().findAll('.icon-row button')) {
      expect(button.find('svg').exists()).toBe(true)
      expect(button.text()).toBe('')
    }
  })

  it('names every action for the keyboard: real buttons with aria-labels', () => {
    const buttons = bar().findAll('.icon-row button')
    expect(buttons.map((b) => b.attributes('aria-label'))).toEqual([
      'Kick',
      'Boost',
      'Chat',
      'Console'
    ])
    for (const button of buttons) {
      expect(button.attributes('type')).toBe('button')
    }
  })

  it('carries a small tooltip naming each action', () => {
    const tip = bar().find('.slot-console .icon-tip')
    expect(tip.text()).toContain('Console')
    expect(tip.text()).toContain("Focus this session's console.")
  })

  it('keeps the old click-to-focus behaviour one click away', async () => {
    const wrapper = bar()
    await wrapper.find('.icon-console').trigger('click')
    expect(wrapper.emitted('open-console')).toHaveLength(1)
  })

  it('closes on Escape', async () => {
    const wrapper = bar()
    await wrapper.find('.action-bar').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('DwarfActionBar chat', () => {
  it('hides the composer until the chat icon is clicked', async () => {
    const wrapper = bar()
    expect(wrapper.find('.message-input').exists()).toBe(false)
    await wrapper.find('.icon-chat').trigger('click')
    expect(wrapper.find('.message-input').exists()).toBe(true)
  })

  it('collapses the composer on a second chat click', async () => {
    const wrapper = bar()
    await wrapper.find('.icon-chat').trigger('click')
    await wrapper.find('.icon-chat').trigger('click')
    expect(wrapper.find('.message-input').exists()).toBe(false)
  })

  it('sends the typed text with the Enter preference', async () => {
    const wrapper = bar()
    await wrapper.find('.icon-chat').trigger('click')
    await wrapper.find('.message-input').setValue('run the tests')
    await wrapper.find('.send-button').trigger('click')

    expect(wrapper.emitted('send')).toEqual([[{ text: 'run the tests', pressEnter: true }]])
  })

  it('lets the sender decide whether the session should submit the line', async () => {
    const wrapper = bar()
    await wrapper.find('.icon-chat').trigger('click')
    await wrapper.find('.message-input').setValue('run the tests')
    await wrapper.find('.press-enter').setValue(false)
    await wrapper.find('.send-button').trigger('click')

    expect(wrapper.emitted('send')).toEqual([[{ text: 'run the tests', pressEnter: false }]])
  })

  it('sends on Enter and adds a newline on Shift+Enter', async () => {
    const wrapper = bar()
    await wrapper.find('.icon-chat').trigger('click')
    await wrapper.find('.message-input').setValue('run the tests')

    await wrapper.find('.message-input').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toBeUndefined()

    await wrapper.find('.message-input').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  it('refuses to send an empty or blank message', async () => {
    const wrapper = bar()
    await wrapper.find('.icon-chat').trigger('click')
    await wrapper.find('.message-input').setValue('   ')
    await wrapper.find('.send-button').trigger('click')

    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.find('.send-button').attributes('disabled')).toBeDefined()
  })

  it('caps the message at the shared delivery limit', async () => {
    const wrapper = bar()
    await wrapper.find('.icon-chat').trigger('click')
    expect(wrapper.find('.message-input').attributes('maxlength')).toBe(
      String(MAX_DWARF_TEXT_CHARS)
    )
  })

  it('disables the chat icon, with its reason in the tooltip, when the session cannot receive text', () => {
    const wrapper = bar({ dwarf: defaultDwarf({ textDelivery: undefined }) })
    expect(wrapper.find('.icon-chat').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.slot-chat .icon-tip').text()).toContain(
      "This session type can't receive messages yet."
    )
  })

  it('names the channel the message will travel through', async () => {
    const wrapper = bar({ dwarf: defaultDwarf({ textDelivery: 'foreman-relay', name: 'Digger' }) })
    await wrapper.find('.icon-chat').trigger('click')
    expect(wrapper.find('.channel-hint').text()).toContain('foreman')
  })

  it('locks the composer while a send is in flight', async () => {
    const wrapper = bar({ sendState: { phase: 'sending' } })
    await wrapper.find('.icon-chat').trigger('click')
    await wrapper.find('.message-input').setValue('hi')
    expect(wrapper.find('.send-button').attributes('disabled')).toBeDefined()
  })

  it('shows the send verdict inside the composer', async () => {
    const failed = bar({ sendState: { phase: 'failed', error: 'The relay never answered.' } })
    await failed.find('.icon-chat').trigger('click')
    expect(failed.find('.send-error').text()).toBe('The relay never answered.')

    const delivered = bar({ sendState: { phase: 'delivered', via: 'terminal' } })
    await delivered.find('.icon-chat').trigger('click')
    expect(delivered.find('.send-ok').text()).toContain('terminal')
  })
})

describe('DwarfActionBar kick', () => {
  function armedBar() {
    return bar({
      dwarf: defaultDwarf({
        // textDelivery keeps chat clickable, so the disarm-on-chat test below
        // exercises a real click instead of a disabled no-op.
        textDelivery: 'terminal',
        capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
      })
    })
  }

  it('disables kick, with a reason in the tooltip, when the session has no cancel channel', () => {
    const wrapper = bar({
      dwarf: defaultDwarf({ capabilities: { sendText: null, cancel: null, adjustEffort: null } })
    })
    expect(wrapper.find('.icon-kick').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.slot-kick .icon-tip').text()).toContain(
      "This session type can't be canceled yet."
    )
  })

  it('disables kick when the dwarf carries no capabilities at all', () => {
    const wrapper = bar({ dwarf: defaultDwarf({ capabilities: undefined }) })
    expect(wrapper.find('.icon-kick').attributes('disabled')).toBeDefined()
  })

  it('names the channel-specific limitation for an enabled kick', () => {
    const relay = bar({
      dwarf: defaultDwarf({
        capabilities: { sendText: 'claude-relay', cancel: 'claude-relay', adjustEffort: null }
      })
    })
    expect(relay.find('.slot-kick .icon-tip').text()).toContain(
      'Asks the agent to stop — it decides how.'
    )
  })

  it('requires a second click to confirm before emitting kick', async () => {
    const wrapper = armedBar()
    const action = wrapper.find('.icon-kick')
    expect(action.attributes('disabled')).toBeUndefined()

    await action.trigger('click')
    expect(wrapper.emitted('kick')).toBeUndefined()
    expect(wrapper.find('.icon-kick').classes()).toContain('is-armed')
    expect(wrapper.find('.icon-kick').attributes('aria-label')).toBe('Confirm kick?')

    await wrapper.find('.icon-kick').trigger('click')
    expect(wrapper.emitted('kick')).toHaveLength(1)
  })

  it('resets the armed confirmation once fired', async () => {
    const wrapper = armedBar()
    await wrapper.find('.icon-kick').trigger('click')
    await wrapper.find('.icon-kick').trigger('click')
    expect(wrapper.emitted('kick')).toHaveLength(1)
    expect(wrapper.find('.icon-kick').classes()).not.toContain('is-armed')
  })

  it('disarms a half-confirmed kick when the chat opens instead', async () => {
    const wrapper = armedBar()
    await wrapper.find('.icon-kick').trigger('click')
    await wrapper.find('.icon-chat').trigger('click')

    await wrapper.find('.icon-kick').trigger('click')
    expect(wrapper.emitted('kick')).toBeUndefined()
  })

  it('locks the kick icon while a kick is in flight', () => {
    const wrapper = bar({
      dwarf: defaultDwarf({
        capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
      }),
      kickState: { phase: 'kicking' }
    })
    const action = wrapper.find('.icon-kick')
    expect(action.attributes('disabled')).toBeDefined()
    expect(action.attributes('aria-label')).toBe('Kicking...')
  })

  it('shows the kick verdict in the bar', () => {
    const failed = bar({
      dwarf: defaultDwarf({
        capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
      }),
      kickState: { phase: 'failed', error: 'The agent terminal could not be reached.' }
    })
    expect(failed.find('.kick-error').text()).toBe('The agent terminal could not be reached.')

    const delivered = bar({
      dwarf: defaultDwarf({
        capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
      }),
      kickState: { phase: 'delivered', via: 'terminal' }
    })
    expect(delivered.find('.kick-ok').text()).toContain('terminal')
  })
})

describe('DwarfActionBar boost', () => {
  it('is always disabled: no provider supports it yet', () => {
    expect(bar().find('.icon-boost').attributes('disabled')).toBeDefined()
  })

  it("names the limitation and the dwarf's current effort, normalized per provider", () => {
    const wrapper = bar({ dwarf: defaultDwarf({ provider: 'claude', effort: 'xhigh' }) })
    const tip = wrapper.find('.slot-boost .icon-tip').text()
    expect(tip).toContain("No provider supports changing a running session's effort yet.")
    expect(tip).toContain('Extra high')
  })

  it('passes a Codex reasoning_effort value through as-is in the tooltip', () => {
    const wrapper = bar({ dwarf: defaultDwarf({ provider: 'codex', effort: 'medium' }) })
    expect(wrapper.find('.slot-boost .icon-tip').text()).toContain('medium')
  })
})

/**
 * Answering what the agent asked (#125). The question is the reason the dwarf
 * was clicked, so it sits above the icons rather than behind the chat toggle —
 * and a dwarf with nothing outstanding keeps exactly the bar it always had.
 */
describe('DwarfActionBar pending question', () => {
  const pendingQuestion = {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    multiSelect: false,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }]
  }

  function asking(props: Record<string, unknown> = {}) {
    return bar({ dwarf: defaultDwarf({ textDelivery: 'terminal', pendingQuestion }), ...props })
  }

  it('shows no question surface for a dwarf with nothing outstanding', () => {
    expect(bar().find('.question-card').exists()).toBe(false)
  })

  it('puts the question above the actions, without waiting for the chat toggle', () => {
    const wrapper = asking()
    expect(wrapper.find('.question-card .question-text').text()).toBe(
      'Which database should the importer write to?'
    )
    const children = [...wrapper.find('.action-bar').element.children]
    expect(children[0]?.classList.contains('question-card')).toBe(true)
  })

  it('forwards the chosen option once Enter confirms it', async () => {
    const wrapper = asking()
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    await wrapper.find('.question-card').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('answer')).toEqual([['SQLite']])
  })

  it('routes a free-form reply through the ordinary message path, not the ask', async () => {
    // The answer channel takes back only the agent's own words; anything else
    // is a message like any other.
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
