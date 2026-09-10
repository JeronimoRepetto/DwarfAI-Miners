// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { CONSOLE_HINT, JUMP_TO_TERMINAL_NAME } from '../../lib/delivery/actionBar'
import { PRESS_ENTER_TO_SEND } from '../../lib/question/questionAnswer'
import { ANSWER_ONLY_WHERE_IT_RUNS, type DwarfQuestion } from '../../types'
import DwarfQuestionCard from './DwarfQuestionCard.vue'

function question(overrides: Partial<DwarfQuestion> = {}): DwarfQuestion {
  return {
    toolUseId: 'toolu_01',
    question: 'Which database should the importer write to?',
    // The default is the answerable case every test below this fixture was
    // written against: a session the panel holds. #354 added the field.
    channel: 'held',
    multiSelect: false,
    questionCount: 1,
    options: [
      { label: 'Postgres', description: 'The one the API already uses.' },
      { label: 'SQLite' },
      { label: 'Neither' }
    ],
    ...overrides
  }
}

function card(props: Record<string, unknown> = {}) {
  return mount(DwarfQuestionCard, { props: { question: question(), ...props } })
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

describe('DwarfQuestionCard', () => {
  it('shows the agent’s question separately from the answer choices', () => {
    const wrapper = card()
    expect(wrapper.find('.question-text').text()).toBe(
      'Which database should the importer write to?'
    )
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.text()).not.toContain('Which database')
    }
  })

  it('shows the agent’s own title for the ask when it wrote one', () => {
    const wrapper = card({ question: question({ header: 'Storage' }) })
    expect(wrapper.find('.question-header').text()).toBe('Storage')
  })

  it('lists one card per agent-supplied option, in the order it offered them', () => {
    const labels = card()
      .findAll('.option-card .option-label')
      .map((node) => node.text())
    expect(labels).toEqual(['Postgres', 'SQLite', 'Neither'])
  })

  it('carries the agent’s gloss on an option beside its label', () => {
    expect(card().find('.option-card .option-description').text()).toBe(
      'The one the API already uses.'
    )
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

  it('marks the clicked option selected and dims the others', async () => {
    const wrapper = card()
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    const classes = wrapper.findAll('.option-card').map((option) => option.classes())
    expect(classes[0]).toContain('is-dimmed')
    expect(classes[1]).toContain('is-selected')
    expect(classes[2]).toContain('is-dimmed')
  })

  it('clears the selection when the selected card is clicked again', async () => {
    const wrapper = card()
    const first = wrapper.findAll('.option-card')[0]!
    await first.trigger('click')
    await first.trigger('click')
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.classes()).toContain('is-base')
    }
  })

  it('does not send on selection alone', async () => {
    const wrapper = card()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('asks for Enter only once something is selected', async () => {
    const wrapper = card()
    expect(wrapper.find('.enter-prompt').exists()).toBe(false)
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    expect(wrapper.find('.enter-prompt').text()).toBe(PRESS_ENTER_TO_SEND)
  })

  it('sends the selected option on Enter', async () => {
    const wrapper = card()
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    pressEnter(wrapper.find('.question-card').element)
    expect(wrapper.emitted('answer')).toEqual([['SQLite']])
  })

  it('sends nothing on Enter while nothing is selected', () => {
    const wrapper = card()
    pressEnter(wrapper.find('.question-card').element)
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('swallows the Enter that would otherwise re-click the selected card', async () => {
    // The selected option keeps focus, and a browser turns Enter on a focused
    // button into a click — which is the gesture that DESELECTS. Sending has to
    // consume the key, or Enter would clear the very choice it is sending.
    const wrapper = card()
    const selected = wrapper.findAll('.option-card')[0]!
    await selected.trigger('click')
    const event = pressEnter(selected.element)
    expect(event.defaultPrevented).toBe(true)
    expect(selected.classes()).toContain('is-selected')
  })

  it('keeps a free-form answer available beside the offered choices', () => {
    const wrapper = card()
    expect(wrapper.find('.freeform-label').text()).toBe('Other Thing')
    expect(wrapper.find('.freeform-input').attributes('placeholder')).toBe('Write here...')
  })

  it('sends free-form text as a message and never as an answer to the ask', async () => {
    // The answer channel takes only the agent's own words back — a free-form
    // reply is not one of them, so it travels the ordinary message path.
    const wrapper = card()
    await wrapper.find('.freeform-input').setValue('use whatever is already there')
    pressEnter(wrapper.find('.freeform-input').element)
    expect(wrapper.emitted('send-text')).toEqual([
      [{ text: 'use whatever is already there', pressEnter: true }]
    ])
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('keeps Shift+Enter writing a newline in the free-form input', async () => {
    const wrapper = card()
    await wrapper.find('.freeform-input').setValue('one line')
    pressEnter(wrapper.find('.freeform-input').element, true)
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })

  it('disables every choice while an answer is in flight', async () => {
    const wrapper = card({ answerState: { phase: 'answering', toolUseId: 'toolu_01' } })
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.attributes('disabled')).toBeDefined()
    }
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('renders main’s reason for a refusal and lets the answer be tried again', async () => {
    const wrapper = card({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_01',
        error: 'That session is not one this panel is holding.'
      }
    })
    expect(wrapper.find('.answer-error').text()).toBe(
      'That session is not one this panel is holding.'
    )
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    pressEnter(wrapper.find('.question-card').element)
    expect(wrapper.emitted('answer')).toEqual([['Postgres']])
  })

  it('says the agent was handed the choice, never that it acted on it', () => {
    const wrapper = card({ answerState: { phase: 'answered', toolUseId: 'toolu_01' } })
    expect(wrapper.find('.answer-ok').text()).toContain('released')
    expect(wrapper.find('.answer-ok').text()).not.toMatch(/reacted|acted on/i)
  })

  it('keeps the question on screen after the answer was released', async () => {
    // The card is drawn from the dwarf's own pendingQuestion, and only main's
    // next snapshot may drop it. Hiding it here would claim the ask was closed
    // on the strength of the panel's own optimism.
    const wrapper = card()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    pressEnter(wrapper.find('.question-card').element)
    await wrapper.setProps({ answerState: { phase: 'answered', toolUseId: 'toolu_01' } })
    expect(wrapper.find('.question-text').exists()).toBe(true)
    expect(wrapper.findAll('.option-card')).toHaveLength(3)
  })

  it('does not offer to answer an ask that was already released', async () => {
    const wrapper = card({ answerState: { phase: 'answered', toolUseId: 'toolu_01' } })
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.attributes('disabled')).toBeDefined()
    }
    pressEnter(wrapper.find('.question-card').element)
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('never shows one ask’s verdict against the next one', async () => {
    const wrapper = card({ answerState: { phase: 'answered', toolUseId: 'toolu_01' } })
    await wrapper.setProps({ question: question({ toolUseId: 'toolu_02' }) })
    expect(wrapper.find('.answer-ok').exists()).toBe(false)
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
  })

  it('starts a new ask unselected, whatever was chosen for the last one', async () => {
    const wrapper = card()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.setProps({ question: question({ toolUseId: 'toolu_02' }) })
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.classes()).toContain('is-base')
    }
  })
  /*
   * A question the panel can only SHOW (#354). The card learns it from the
   * ask's own `channel`, which main derives from the same evidence
   * `answerDwarfQuestion` guards on — see DwarfPromptChannel.
   */
  describe('a question this panel cannot answer', () => {
    function observed(overrides: Partial<DwarfQuestion> = {}) {
      return card({ question: question({ channel: 'terminal', ...overrides }) })
    }

    it('keeps the header, the question and every option on screen', () => {
      const wrapper = observed({ header: 'Storage' })
      expect(wrapper.find('.question-header').text()).toBe('Storage')
      expect(wrapper.find('.question-text').text()).toBe(
        'Which database should the importer write to?'
      )
      expect(wrapper.findAll('.option-card')).toHaveLength(3)
    })

    it('makes no option selectable', async () => {
      const wrapper = observed()
      for (const option of wrapper.findAll('.option-card')) {
        expect(option.attributes('disabled')).toBeDefined()
        expect(option.attributes('aria-pressed')).toBe('false')
      }
      await wrapper.findAll('.option-card')[0]!.trigger('click')
      for (const option of wrapper.findAll('.option-card')) {
        expect(option.classes()).toContain('is-base')
        expect(option.attributes('aria-pressed')).toBe('false')
      }
      expect(wrapper.emitted('answer')).toBeUndefined()
      expect(wrapper.find('.enter-prompt').exists()).toBe(false)
    })

    it('says where the answer goes in the runtime’s own words, not a second copy', () => {
      expect(observed().find('.answer-error').text()).toContain(ANSWER_ONLY_WHERE_IT_RUNS)
    })

    it('offers exactly one jump, drawn as the permission card draws it', () => {
      const jumps = observed().findAll('.answer-jump')
      expect(jumps).toHaveLength(1)
      expect(jumps[0]!.text()).toBe(JUMP_TO_TERMINAL_NAME)
      expect(jumps[0]!.attributes('title')).toBe(CONSOLE_HINT)
    })

    it('asks for the console when the jump is pressed', async () => {
      const wrapper = observed()
      await wrapper.find('.answer-jump').trigger('click')
      expect(wrapper.emitted('open-console')).toHaveLength(1)
    })

    it('leaves the jump on the keyboard’s path while the options are off it', () => {
      // A disabled button is skipped by the browser's own tab order, so the
      // jump being an ordinary enabled button is the whole of what this needs.
      const jump = observed().find('.answer-jump')
      expect(jump.element.tagName).toBe('BUTTON')
      expect(jump.attributes('type')).toBe('button')
      expect(jump.attributes('disabled')).toBeUndefined()
    })

    it('sends nothing on Enter, and does not swallow the key', () => {
      const wrapper = observed()
      const event = pressEnter(wrapper.find('.question-card').element)
      expect(wrapper.emitted('answer')).toBeUndefined()
      expect(event.defaultPrevented).toBe(false)
    })

    it('still lets a free-form reply leave on the ordinary message path', async () => {
      // Unanswerable is about the ANSWER channel. Telling the session
      // something is a message, and that path is untouched here.
      const wrapper = observed()
      await wrapper.find('.freeform-input').setValue('write to Postgres')
      pressEnter(wrapper.find('.freeform-input').element)
      expect(wrapper.emitted('send-text')).toEqual([
        [{ text: 'write to Postgres', pressEnter: true }]
      ])
    })

    it('leaves a held session’s question answerable, with no jump beside it', async () => {
      const wrapper = card()
      for (const option of wrapper.findAll('.option-card')) {
        expect(option.attributes('disabled')).toBeUndefined()
      }
      expect(wrapper.find('.answer-jump').exists()).toBe(false)
      expect(wrapper.find('.answer-error').exists()).toBe(false)
      await wrapper.findAll('.option-card')[1]!.trigger('click')
      pressEnter(wrapper.find('.question-card').element)
      expect(wrapper.emitted('answer')).toEqual([['SQLite']])
    })
  })
})
