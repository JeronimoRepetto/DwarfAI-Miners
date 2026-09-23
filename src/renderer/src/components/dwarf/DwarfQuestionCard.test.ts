// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { CONSOLE_HINT, JUMP_TO_TERMINAL_NAME } from '../../lib/delivery/actionBar'
import {
  PRESS_ENTER_TO_SEND,
  SEND_ANSWER_NAME,
  SUBMIT_ANSWERS_NAME
} from '../../lib/question/questionAnswer'
import {
  ANSWER_ONLY_WHERE_IT_RUNS,
  TYPED_HERE_REACHES_THE_PICKER,
  joinAnswerLabels,
  type DwarfAskQuestion,
  type DwarfQuestion
} from '../../types'
import DwarfQuestionCard from './DwarfQuestionCard.vue'

/*
 * AMENDED for #443 (was: `Partial<DwarfQuestion>` spread over a flat ask with
 * `questionCount: 1`). The call's own fields and its one question's fields are
 * two levels now; an override may name either, and this puts each where it
 * belongs. A case about a several-question call uses `several` below.
 */
type QuestionOverrides = Partial<DwarfAskQuestion> &
  Partial<Pick<DwarfQuestion, 'toolUseId' | 'channel' | 'questions'>>

function question(overrides: QuestionOverrides = {}): DwarfQuestion {
  const { toolUseId, channel, questions, ...asked } = overrides
  return {
    toolUseId: toolUseId ?? 'toolu_01',
    // The default is the answerable case every test below this fixture was
    // written against: a session the panel holds. #354 added the field.
    channel: channel ?? 'held',
    questions: questions ?? [
      {
        question: 'Which database should the importer write to?',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: 'The one the API already uses.' },
          { label: 'SQLite' },
          { label: 'Neither' }
        ],
        ...asked
      }
    ]
  }
}

/** The same call with a second question behind the first — what `questionCount: 2` stood for. */
function several(overrides: QuestionOverrides = {}): DwarfQuestion {
  const one = question(overrides)
  return {
    ...one,
    questions: [
      ...one.questions,
      { question: 'Which region?', multiSelect: false, options: [{ label: 'East' }] }
    ]
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
   * A question the panel can only SHOW (#354, #362). The card learns it from
   * the ask's own `channel` and its `questions` (`questionCount` before #443),
   * which main derives from the
   * same evidence `answerDwarfQuestion` guards on — see DwarfPromptChannel.
   *
   * AMENDED for #362: `observed()` was a terminal-channel ask with ONE
   * question, which was the whole of unanswerable when #354 wrote these. A
   * one-question ask is now typed into the session's own console, so what is
   * left unanswerable — and what every case below is therefore about — is a
   * call that asked SEVERAL questions, because only its first is on the wire.
   * Not one expectation in the block is weaker; the fixture names the case the
   * block was always describing.
   *
   * AMENDED again for #443 (was: `questionCount: 2` on a flat ask). The same
   * call, with its second question carried now; it is still unanswerable here,
   * for the unmeasured walk between the questions, and the card still draws
   * the first. Every expectation below stands as it was.
   */
  describe('a question this panel cannot answer', () => {
    function observed(overrides: QuestionOverrides = {}) {
      return card({ question: several({ channel: 'terminal', ...overrides }) })
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

    /*
     * AMENDED for #481 (was: 'still lets a free-form reply leave on the
     * ordinary message path', which set the box to 'write to Postgres' and
     * asserted `send-text` carried it). A deliberate tightening: the premise of
     * that test — "the message path is untouched here" — was false on this
     * channel. The ordinary message path writes into the session's own console,
     * and the picker standing at that console reads the letters as its own
     * input while the Enter behind them confirms whichever option is
     * highlighted. So the box is gone, and the card says where the words go.
     */
    it('offers no free-text box, because the picker there would read it', () => {
      const wrapper = observed()
      expect(wrapper.find('.freeform-input').exists()).toBe(false)
      expect(wrapper.find('.freeform-refused').text()).toContain(TYPED_HERE_REACHES_THE_PICKER)
    })

    it('says several questions, and names no provider (#360)', () => {
      // #360: the sentence used to tell the reader about "a Codex thread" on a
      // card that is drawn for an observed Claude session just as often.
      const text = observed().find('.answer-error').text()
      expect(text).toContain('several questions')
      expect(text).not.toMatch(/codex|claude|gemini/i)
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

/*
 * A question the panel CAN answer at the session's own console (#362). The
 * card learns that from the ask's `channel` and how many `questions` it carries
 * (`questionCount` before #443) — the same two
 * fields main's own guard reads — so what the card offers and what main will
 * accept cannot come apart.
 */
describe('a question answered at the session’s own terminal', () => {
  // AMENDED for #443 (was: `Partial<DwarfQuestion>`) — see QuestionOverrides.
  function observedSingle(overrides: QuestionOverrides = {}) {
    return card({ question: question({ channel: 'terminal', ...overrides }) })
  }

  it('offers every option, exactly as a held session’s ask does', async () => {
    const wrapper = observedSingle()
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    expect(wrapper.findAll('.option-card')[1]!.classes()).toContain('is-selected')
  })

  it('sends the chosen option on Enter, as the held channel does', async () => {
    const wrapper = observedSingle()
    await wrapper.findAll('.option-card')[2]!.trigger('click')
    pressEnter(wrapper.find('.question-card').element)
    expect(wrapper.emitted('answer')).toEqual([['Neither']])
  })

  /*
   * AMENDED for #481 (was: 'draws no refusal and no jump while it can be
   * answered', asserting `.answer-jump` absent ANYWHERE on the card). The card
   * has a second, legitimate jump since #481 — the one beside the refused
   * free-text box, which is where a person answering in their own words has to
   * go. So the assertion is re-aimed at the row it was always about. Nothing is
   * weaker: the refusal row is still pinned absent, and the box's own jump is
   * pinned present by the #481 block above.
   */
  it('draws no refusal row, and no jump belonging to one, while it can be answered', () => {
    const wrapper = observedSingle()
    expect(wrapper.find('.answer-error').exists()).toBe(false)
    expect(wrapper.find('.answer-error .answer-jump').exists()).toBe(false)
  })

  /* --- The free-text box at a picker (#481) — one block, appended ---------- */

  /*
   * AMENDED for #481 item 3 (was: 'offers no free-text box, and says what
   * typing here would really reach', asserting `.freeform-input` absent and the
   * refusal sentence shown). PR #484 shipped that refusal as a stop-gap while
   * the picker's own "Other" row was unmeasured. It has been measured now
   * (2026-09-18, Claude Code 2.1.276), so on THIS shape — one question, one
   * answer — the box is back and what it sends is an ANSWER. The refusal is
   * unchanged for every shape the measurement does not cover, and those tests
   * are below and in the multi-select block.
   */
  it('offers the box back, because the picker’s own Other row is measured', () => {
    const wrapper = observedSingle()
    expect(wrapper.find('.freeform-input').exists()).toBe(true)
    expect(wrapper.find('.freeform-refused').exists()).toBe(false)
  })

  it('sends what was typed as an ANSWER, never on the message path', async () => {
    // THE repair. The words are typed into the row the agent's own picker
    // offers for them; they must not leave as a message, which on this channel
    // writes into the same console the picker is drawn in.
    const wrapper = observedSingle()
    await wrapper.find('.freeform-input').setValue('put it in Redis')
    pressEnter(wrapper.find('.freeform-input').element)
    expect(wrapper.emitted('answer-text')).toEqual([['put it in Redis']])
    expect(wrapper.emitted('send-text')).toBeUndefined()
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('keeps Shift+Enter writing a newline rather than sending', async () => {
    const wrapper = observedSingle()
    await wrapper.find('.freeform-input').setValue('one line')
    pressEnter(wrapper.find('.freeform-input').element, true)
    expect(wrapper.emitted('answer-text')).toBeUndefined()
  })

  it('sends nothing for an empty box', async () => {
    const wrapper = observedSingle()
    await wrapper.find('.freeform-input').setValue('   ')
    pressEnter(wrapper.find('.freeform-input').element)
    expect(wrapper.emitted('answer-text')).toBeUndefined()
  })

  it('sends no typed answer while one is already in flight', async () => {
    // A second release of the same blocked tool call, from the one control on
    // the card that is not a disabled button.
    const wrapper = observedSingle()
    await wrapper.setProps({ answerState: { phase: 'answering', toolUseId: 'toolu_01' } })
    await wrapper.find('.freeform-input').setValue('put it in Redis')
    pressEnter(wrapper.find('.freeform-input').element)
    expect(wrapper.emitted('answer-text')).toBeUndefined()
  })

  /*
   * AMENDED for #481 item 3 (was: 'names the two ways out that do work, and no
   * provider', read off `observedSingle`). That card has no refusal row to read
   * any more, so the case is re-aimed at the shape that still carries the
   * sentence — a multi-select ask at a terminal, whose Other row is unmeasured.
   * Nothing is weaker: the same three clauses are asserted, on the card that
   * still shows them.
   */
  it('names the two ways out that do work, and no provider, where it still refuses', () => {
    const refused = card({ question: question({ channel: 'terminal', multiSelect: true }) })
    const text = refused.find('.freeform-refused').text()
    expect(text).toMatch(/picker/i)
    expect(text).toMatch(/terminal/i)
    expect(text).not.toMatch(/codex|claude|gemini/i)
  })

  /*
   * AMENDED for #481 item 3 (was: 'offers the way to that terminal beside the
   * refused box', read off `observedSingle`). Re-aimed at the same still-refused
   * shape, for the same reason as the case above, and asserting exactly what it
   * asserted before.
   */
  it('offers the way to that terminal beside a box it still refuses', async () => {
    const refused = card({ question: question({ channel: 'terminal', multiSelect: true }) })
    const jump = refused.find('.freeform-refused .answer-jump')
    expect(jump.text()).toBe(JUMP_TO_TERMINAL_NAME)
    expect(jump.attributes('title')).toBe(CONSOLE_HINT)
    await jump.trigger('click')
    expect(refused.emitted('open-console')).toHaveLength(1)
  })

  it('emits nothing on the message path from this card at all', async () => {
    // AMENDED for #481 item 3 (was: 'emits nothing on the message path while
    // the box is refused'). The box is back, so what this pins is the stronger
    // fact it was always after: on this channel nothing this card can do puts
    // words on the message path.
    // The box first, because choosing an option swaps it for the send prompt —
    // the design's one surface that says what happens next (#125).
    const wrapper = observedSingle()
    await wrapper.find('.freeform-input').setValue('put it in Redis')
    pressEnter(wrapper.find('.freeform-input').element)
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    pressEnter(wrapper.find('.question-card').element)
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })

  it('refuses the box for an ask with more options than the picker numbers', () => {
    // The digit runs out at nine and the rows may scroll past them, which is
    // exactly where the counted reach stops being derivable from what was
    // measured — so the sentence, not a guess.
    const eleven = Array.from({ length: 11 }, (_, index) => ({ label: `Option ${index + 1}` }))
    const wrapper = card({ question: question({ channel: 'terminal', options: eleven }) })
    expect(wrapper.find('.freeform-input').exists()).toBe(false)
    expect(wrapper.find('.freeform-refused').text()).toContain(TYPED_HERE_REACHES_THE_PICKER)
  })

  it('keeps the box on a held session’s ask, whose text touches no picker', () => {
    // #125's path is untouched: those words are queued on the stream this panel
    // holds, so nothing about them reaches a TUI.
    const wrapper = card()
    expect(wrapper.find('.freeform-input').exists()).toBe(true)
    expect(wrapper.find('.freeform-refused').exists()).toBe(false)
  })

  it('shows main’s refusal with the way to the terminal beside it', async () => {
    // A refusal on this channel is about a console, so the jump is what the
    // person needs next — unlike a held refusal, which is about the stream.
    const wrapper = observedSingle()
    await wrapper.setProps({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_01',
        error: 'The panel could not reach the console this session runs in.'
      }
    })
    expect(wrapper.find('.answer-error').text()).toContain('could not reach the console')
    expect(wrapper.find('.answer-jump').exists()).toBe(true)
  })
})

/*
 * A multi-select ask on that channel (#362). Its options are toggles and an
 * explicit Answer control sends, because that is what the measured keystroke
 * gesture is — one digit per chosen option, then a confirmation — and because
 * nothing may be typed into somebody's console until they say so.
 */
describe('a multi-select question at the session’s own terminal', () => {
  // AMENDED for #443 (was: `Partial<DwarfQuestion>`) — see QuestionOverrides.
  function multi(overrides: QuestionOverrides = {}) {
    return card({
      question: question({ channel: 'terminal', multiSelect: true, ...overrides })
    })
  }

  it('keeps every toggled option selected, dimming none of the others', async () => {
    const wrapper = multi()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.findAll('.option-card')[2]!.trigger('click')
    const classes = wrapper.findAll('.option-card').map((option) => option.classes())
    expect(classes[0]).toContain('is-selected')
    expect(classes[1]).toContain('is-base')
    expect(classes[2]).toContain('is-selected')
  })

  it('reports every toggle to a screen reader as pressed', async () => {
    const wrapper = multi()
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    const pressed = wrapper.findAll('.option-card').map((o) => o.attributes('aria-pressed'))
    expect(pressed).toEqual(['false', 'true', 'false'])
  })

  it('turns a toggle off again when it is clicked twice', async () => {
    const wrapper = multi()
    const first = wrapper.findAll('.option-card')[0]!
    await first.trigger('click')
    await first.trigger('click')
    expect(first.classes()).toContain('is-base')
    expect(wrapper.find('.answer-send').exists()).toBe(false)
  })

  it('offers the Answer control only once something is toggled', async () => {
    const wrapper = multi()
    expect(wrapper.find('.answer-send').exists()).toBe(false)
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    expect(wrapper.find('.answer-send').text()).toBe(SEND_ANSWER_NAME)
  })

  it('sends nothing on a toggle, however many are on', async () => {
    // The whole reason the control exists: a toggle is not an answer, and the
    // panel must never type one into a console nobody has released.
    const wrapper = multi()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('emits once with every toggled label when the Answer control is pressed', async () => {
    const wrapper = multi()
    await wrapper.findAll('.option-card')[2]!.trigger('click')
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.find('.answer-send').trigger('click')

    // In the ask's OWN option order, not the order they were clicked: main
    // presses a digit per option position.
    expect(wrapper.emitted('answer')).toEqual([[joinAnswerLabels(['Postgres', 'Neither'])]])
  })

  it('does not send on Enter: this ask has a control of its own', async () => {
    const wrapper = multi()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    const event = pressEnter(wrapper.find('.question-card').element)
    expect(wrapper.emitted('answer')).toBeUndefined()
    expect(event.defaultPrevented).toBe(false)
  })

  /*
   * AMENDED for #481 (was: 'keeps the free-form box until something is toggled,
   * and never sends it as an answer', which set the box to 'all of them' and
   * asserted `send-text` carried it). The same tightening the several-question
   * block took, for the same fact: this ask is drawn at a terminal picker too,
   * so there is no box to fill and nothing leaves on the message path.
   */
  it('offers no free-text box either, toggled or not', async () => {
    const wrapper = multi()
    expect(wrapper.find('.freeform-input').exists()).toBe(false)
    expect(wrapper.find('.freeform-refused').text()).toContain(TYPED_HERE_REACHES_THE_PICKER)
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    expect(wrapper.emitted('send-text')).toBeUndefined()
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('takes no toggle and offers no control while an answer is in flight', async () => {
    const wrapper = multi({ toolUseId: 'toolu_01' })
    await wrapper.setProps({ answerState: { phase: 'answering', toolUseId: 'toolu_01' } })
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.attributes('disabled')).toBeDefined()
    }
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    expect(wrapper.find('.answer-send').exists()).toBe(false)
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('starts a new ask with nothing toggled', async () => {
    const wrapper = multi()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.setProps({
      question: question({ channel: 'terminal', multiSelect: true, toolUseId: 'toolu_02' })
    })
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.classes()).toContain('is-base')
    }
    expect(wrapper.find('.answer-send').exists()).toBe(false)
  })

  /*
   * F2 (review finding, #588 T5): `freeTextRoute` grew a fourth value,
   * 'closed', for the OpenCode permission channel. The template used to
   * gate the textarea on `freeText !== 'picker'` — a negative check that a
   * NEW union member satisfies by default, so 'closed' would render the box
   * anyway. Its Enter emits send-text, a channel runtime.ts refuses outright
   * (questionAnswer.ts's own "the worse of the two failures available
   * here" comment). Unreachable today ('opencode-permission' is stamped only
   * on pendingPermission, never on a DwarfQuestion — see freeTextRoute's own
   * doc comment), but DwarfPromptChannel admits the value on a DwarfQuestion
   * too, so this pins it directly rather than relying on that never
   * happening in practice.
   */
  it('never offers the free-text box for a route the union does not name as safe (F2)', () => {
    const wrapper = card({ question: question({ channel: 'opencode-permission' }) })
    expect(wrapper.find('.freeform-input').exists()).toBe(false)
  })

  /*
   * AMENDED for #443 T3b (was: "keeps a HELD multi-select ask on the
   * single-choice gesture it always had" — the held channel took one label
   * per question, on the strength of an unmeasured picker separator.
   * `@anthropic-ai/claude-agent-sdk` 0.3.258's own `sdk-tools.d.ts` now
   * documents `AskUserQuestionOutput.answers` as "question text -> answer
   * string; multi-select answers are comma-separated", and `resolveAnswers`
   * (main, heldSession.ts) already accepts several labels for a `multiSelect`
   * question on the strength of that measurement — so the card stops
   * singling the held channel out too, and this ask toggles like the
   * terminal one, sending through the same explicit Answer control.
   */
  it('toggles a HELD multi-select ask and sends every toggle through the Answer control', async () => {
    const wrapper = card({ question: question({ multiSelect: true }) })
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    expect(wrapper.findAll('.option-card')[0]!.classes()).toContain('is-selected')
    expect(wrapper.findAll('.option-card')[1]!.classes()).toContain('is-selected')
    expect(wrapper.find('.answer-send').exists()).toBe(true)
    await wrapper.find('.answer-send').trigger('click')
    expect(wrapper.emitted('answer')).toEqual([[joinAnswerLabels(['Postgres', 'SQLite'])]])
  })

  it('sends nothing on a HELD multi-select ask with zero toggles', () => {
    const wrapper = card({ question: question({ multiSelect: true }) })
    expect(wrapper.find('.answer-send').exists()).toBe(false)
    const event = pressEnter(wrapper.find('.question-card').element)
    expect(wrapper.emitted('answer')).toBeUndefined()
    expect(event.defaultPrevented).toBe(false)
  })
})

/*
 * A call that asked SEVERAL questions (#443). The card shows one at a time,
 * Back and Next walk between them, and ONE Submit on the last sends every
 * answer — only once each question has one. A held session is answered that
 * way end to end; a terminal one can be walked to read, and nothing more, until
 * the picker's own walk between questions is measured.
 */
describe('a call that asks several questions (#443)', () => {
  function pair(overrides: Partial<Pick<DwarfQuestion, 'toolUseId' | 'channel'>> = {}) {
    return question({
      ...overrides,
      questions: [
        {
          question: 'Which database?',
          header: 'Storage',
          multiSelect: false,
          options: [{ label: 'Postgres' }, { label: 'SQLite' }]
        },
        {
          question: 'Which regions?',
          header: 'Regions',
          multiSelect: true,
          options: [{ label: 'East' }, { label: 'West' }, { label: 'North' }]
        }
      ]
    })
  }

  function walk(overrides: Partial<Pick<DwarfQuestion, 'toolUseId' | 'channel'>> = {}) {
    return card({ question: pair(overrides) })
  }

  async function next(wrapper: ReturnType<typeof card>) {
    await wrapper.find('.question-next').trigger('click')
  }

  async function back(wrapper: ReturnType<typeof card>) {
    await wrapper.find('.question-back').trigger('click')
  }

  it('draws none of the walk for a one-question call', () => {
    const wrapper = card()
    expect(wrapper.find('.question-step').exists()).toBe(false)
    expect(wrapper.find('.question-back').exists()).toBe(false)
    expect(wrapper.find('.question-next').exists()).toBe(false)
    expect(wrapper.find('.answer-submit').exists()).toBe(false)
  })

  it('shows question 1 of n first, with its own header and options', () => {
    const wrapper = walk()
    expect(wrapper.find('.question-step').text()).toBe('Question 1 of 2')
    expect(wrapper.find('.question-header').text()).toBe('Storage')
    expect(wrapper.find('.question-text').text()).toBe('Which database?')
    expect(wrapper.findAll('.option-card .option-label').map((node) => node.text())).toEqual([
      'Postgres',
      'SQLite'
    ])
  })

  it('moves to the next question and back again', async () => {
    const wrapper = walk()
    await next(wrapper)
    expect(wrapper.find('.question-step').text()).toBe('Question 2 of 2')
    expect(wrapper.find('.question-header').text()).toBe('Regions')
    expect(wrapper.find('.question-text').text()).toBe('Which regions?')
    expect(wrapper.findAll('.option-card')).toHaveLength(3)
    await back(wrapper)
    expect(wrapper.find('.question-text').text()).toBe('Which database?')
  })

  it('offers no Back on the first question and no Next on the last', async () => {
    const wrapper = walk()
    expect(wrapper.find('.question-back').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.question-next').attributes('disabled')).toBeUndefined()
    await next(wrapper)
    expect(wrapper.find('.question-back').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.question-next').attributes('disabled')).toBeDefined()
  })

  it('draws the Submit only on the last question', async () => {
    const wrapper = walk()
    expect(wrapper.find('.answer-submit').exists()).toBe(false)
    await next(wrapper)
    expect(wrapper.find('.answer-submit').text()).toBe(SUBMIT_ANSWERS_NAME)
  })

  it('cannot submit while any question is unanswered', async () => {
    const wrapper = walk()
    await next(wrapper)
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    const submit = wrapper.find('.answer-submit')
    expect(submit.attributes('disabled')).toBeDefined()
    await submit.trigger('click')
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('never shows a choice made on question 1 on question 2', async () => {
    const wrapper = walk()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await next(wrapper)
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.classes()).toContain('is-base')
      expect(option.attributes('aria-pressed')).toBe('false')
    }
  })

  it('keeps a choice on its own question when the walk comes back to it', async () => {
    const wrapper = walk()
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    await next(wrapper)
    await back(wrapper)
    expect(wrapper.findAll('.option-card')[1]!.classes()).toContain('is-selected')
    expect(wrapper.findAll('.option-card')[0]!.classes()).toContain('is-dimmed')
  })

  it('starts another ask on its first question with nothing chosen', async () => {
    const wrapper = walk()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await next(wrapper)
    await wrapper.setProps({ question: pair({ toolUseId: 'toolu_02' }) })
    expect(wrapper.find('.question-step').text()).toBe('Question 1 of 2')
    for (const option of wrapper.findAll('.option-card')) {
      expect(option.classes()).toContain('is-base')
    }
  })

  /*
   * AMENDED for #443 T3b (was: "A held call, one single-select and one
   * multi-select question. The held channel takes one label per question, so
   * the multi-select one keeps the single-choice gesture the one-question
   * card gives it" — the two clicks below replaced one choice with the
   * other). The held channel now toggles a multi-select question exactly as
   * the terminal one does (see togglesAt, questionAnswer.ts, and the SDK
   * evidence there), so both clicks stay toggled and Submit carries both,
   * joined in the ask's own option order.
   */
  it('sends one answer with every question’s value when Submit is pressed, toggling a held multi-select question', async () => {
    const wrapper = walk()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await next(wrapper)
    await wrapper.findAll('.option-card')[2]!.trigger('click')
    await wrapper.findAll('.option-card')[1]!.trigger('click')
    const submit = wrapper.find('.answer-submit')
    expect(submit.attributes('disabled')).toBeUndefined()
    await submit.trigger('click')
    expect(wrapper.emitted('answer')).toEqual([[['Postgres', joinAnswerLabels(['West', 'North'])]]])
  })

  it('sends nothing on Enter: the walk has a Submit of its own', async () => {
    const wrapper = walk()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await next(wrapper)
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    const event = pressEnter(wrapper.find('.question-card').element)
    expect(wrapper.emitted('answer')).toBeUndefined()
    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.find('.enter-prompt').exists()).toBe(false)
  })

  it('takes no Submit while an answer is already in flight', async () => {
    const wrapper = walk()
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await next(wrapper)
    await wrapper.findAll('.option-card')[0]!.trigger('click')
    await wrapper.setProps({ answerState: { phase: 'answering', toolUseId: 'toolu_01' } })
    const submit = wrapper.find('.answer-submit')
    expect(submit.attributes('disabled')).toBeDefined()
    await submit.trigger('click')
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  describe('at a terminal, where the walk between questions is unmeasured', () => {
    it('can be walked to read every question', async () => {
      const wrapper = walk({ channel: 'terminal' })
      expect(wrapper.find('.question-next').attributes('disabled')).toBeUndefined()
      await next(wrapper)
      expect(wrapper.find('.question-text').text()).toBe('Which regions?')
      await back(wrapper)
      expect(wrapper.find('.question-text').text()).toBe('Which database?')
    })

    it('makes nothing selectable on any question, and offers no Submit', async () => {
      const wrapper = walk({ channel: 'terminal' })
      for (const step of [0, 1]) {
        if (step === 1) await next(wrapper)
        for (const option of wrapper.findAll('.option-card')) {
          expect(option.attributes('disabled')).toBeDefined()
          await option.trigger('click')
          expect(option.classes()).toContain('is-base')
        }
      }
      expect(wrapper.find('.answer-submit').exists()).toBe(false)
      expect(wrapper.find('.answer-send').exists()).toBe(false)
      expect(wrapper.emitted('answer')).toBeUndefined()
    })

    it('keeps the one refusal and the one jump on every question', async () => {
      const wrapper = walk({ channel: 'terminal' })
      await next(wrapper)
      expect(wrapper.find('.answer-error').text()).toContain(ANSWER_ONLY_WHERE_IT_RUNS)
      expect(wrapper.findAll('.answer-jump')).toHaveLength(1)
    })
  })
})
