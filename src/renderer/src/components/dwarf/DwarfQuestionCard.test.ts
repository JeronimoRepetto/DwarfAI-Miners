// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { CONSOLE_HINT, JUMP_TO_TERMINAL_NAME } from '../../lib/delivery/actionBar'
import { SUBMIT_ANSWERS_NAME } from '../../lib/question/questionAnswer'
import {
  OTHER_PLACEHOLDER,
  OTHER_THING_LABEL,
  SEND_OTHER_NAME
} from '../../lib/question/questionCard'
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
  return mount(DwarfQuestionCard, {
    props: { question: question(), name: 'dwarfai-54', ...props },
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
 * AMENDED for #635 (the question card rebuilt from the design; was: `.option-card` buttons drawn
 * in three states, `is-base`, `is-selected` and `is-dimmed`, and `aria-pressed`). Every case below
 * reads the design's card: an option is a `.dm-qopt` row whose `aria-checked` says whether it is
 * picked — the design draws picked and not picked, and nothing dimmed — and "Other thing…" is the
 * last row of every step, apart from the agent's options. The walk's Submit is the one send: Enter
 * on the last step does nothing (components.md, Question card, as built: "On the last step Enter
 * does nothing: only Submit sends"), so every "Enter sends" case now presses Submit, each noted.
 */
type Card = VueWrapper

function options(wrapper: Card) {
  return wrapper.findAll('.dm-qopt:not(.dm-qopt--other)')
}

function labelsOf(wrapper: Card): string[] {
  return options(wrapper).map((option) => option.find('.dm-qopt__label').text())
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

/** Pick "Other thing…" and write into the field it opens. */
async function writeOther(wrapper: Card, text: string): Promise<void> {
  await otherRow(wrapper).trigger('click')
  await wrapper.find('.dm-qopt-other-field input').setValue(text)
}

function pressKey(element: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  element.dispatchEvent(event)
  return event
}

describe('DwarfQuestionCard', () => {
  it('shows the agent’s question separately from the answer choices', () => {
    const wrapper = card()
    expect(wrapper.find('.dm-qcard__q').text()).toBe('Which database should the importer write to?')
    for (const option of options(wrapper)) {
      expect(option.text()).not.toContain('Which database')
    }
  })

  it('shows the agent’s own title for the ask when it wrote one', () => {
    const wrapper = card({ question: question({ header: 'Storage' }) })
    expect(wrapper.find('.dm-qcard__header').text()).toBe('Storage')
  })

  it('lists one card per agent-supplied option, in the order it offered them', () => {
    expect(labelsOf(card())).toEqual(['Postgres', 'SQLite', 'Neither'])
  })

  /*
   * AMENDED for #635 (was: the gloss in `.option-description` beside the label). Decided since:
   * the design lead's ruling on MESSAGE-QUESTIONS 6 (2026-09-28) — a description the agent sent
   * shows as Small text under the label, inside the same option.
   */
  it('carries the agent’s gloss on an option under its label, inside the same row', () => {
    const first = options(card())[0]!
    expect(first.find('.dm-qopt__desc').text()).toBe('The one the API already uses.')
    expect(options(card())[1]!.find('.dm-qopt__desc').exists()).toBe(false)
  })

  it('makes every choice a real button so the keyboard reaches it', () => {
    for (const option of options(card())) {
      expect(option.element.tagName).toBe('BUTTON')
      expect(option.attributes('type')).toBe('button')
    }
  })

  it('draws every card in its base state before anything is chosen', () => {
    expect(checked(card())).toEqual(['false', 'false', 'false'])
  })

  // AMENDED for #635 (was: the others dimmed): the design draws picked and not picked only.
  it('marks the clicked option picked and leaves the others as they were', async () => {
    const wrapper = card()
    await options(wrapper)[1]!.trigger('click')
    expect(checked(wrapper)).toEqual(['false', 'true', 'false'])
  })

  it('clears the selection when the selected card is clicked again', async () => {
    const wrapper = card()
    const first = options(wrapper)[0]!
    await first.trigger('click')
    await first.trigger('click')
    expect(checked(wrapper)).toEqual(['false', 'false', 'false'])
  })

  it('does not send on selection alone', async () => {
    const wrapper = card()
    await options(wrapper)[0]!.trigger('click')
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  /*
   * AMENDED for #635 (was: 'asks for Enter only once something is selected', the "Press ENTER to
   * send" line): the card has no such line; its Submit wakes once the step is answered.
   */
  it('wakes Submit only once something is selected', async () => {
    const wrapper = card()
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    await options(wrapper)[0]!.trigger('click')
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(submitButton(wrapper).text()).toBe(SUBMIT_ANSWERS_NAME)
  })

  // AMENDED for #635 (was: 'sends the selected option on Enter'): Submit is the one send.
  it('sends the selected option on Submit', async () => {
    const wrapper = card()
    await options(wrapper)[1]!.trigger('click')
    await submit(wrapper)
    expect(wrapper.emitted('answer')).toEqual([['SQLite']])
  })

  it('sends nothing on Enter while nothing is selected', () => {
    const wrapper = card()
    pressEnter(wrapper.find('.dm-qcard').element)
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  /*
   * AMENDED for #635 (was: the swallowed Enter was the one that SENT). Enter on the last step does
   * nothing, and still never re-picks the row: its native click is prevented (components.md).
   */
  it('swallows the Enter that would otherwise re-click the selected card, and sends nothing', async () => {
    // The selected option keeps focus, and a browser turns Enter on a focused
    // button into a click — which is the gesture that DESELECTS.
    const wrapper = card()
    const selected = options(wrapper)[0]!
    await selected.trigger('click')
    const event = pressEnter(selected.element)
    expect(event.defaultPrevented).toBe(true)
    expect(selected.attributes('aria-checked')).toBe('true')
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  /*
   * AMENDED for #635 (was: an "Other Thing" label over an always-open box, "Write here..."). The
   * design's last row, "Other thing…", opens the field under the options, with focus.
   */
  it('keeps a free-form answer available beside the offered choices', async () => {
    const wrapper = card()
    expect(otherRow(wrapper).find('.dm-qopt__label').text()).toBe(OTHER_THING_LABEL)
    expect(wrapper.find('.dm-qopt-other-field').exists()).toBe(false)
    await otherRow(wrapper).trigger('click')
    const field = wrapper.find('.dm-qopt-other-field input')
    expect(field.attributes('placeholder')).toBe(OTHER_PLACEHOLDER)
    expect(document.activeElement).toBe(field.element)
  })

  /*
   * AMENDED for #635 (was: Enter in the box sent it).
   * AMENDED again for #635 (was: Submit read "Send" while the words were picked, the permission's
   * rule). On a question the words are the step's free answer (screens/message.md, Question card,
   * as built): Submit keeps its name, and "Send" belongs to a permission alone. What leaves on a
   * held session is unchanged from today: main's held path releases the ask with its own labels
   * only (TYPED_ANSWER_ONLY_AT_A_PICKER, resolveAnswers), so the words travel the message path.
   * AMENDED for #635 (PO decision 2026-09-28, held free-text answers; was: 'sends free-form text
   * as a message and never as an answer to the ask', expecting `send-text`). Main now takes a
   * held question's own words as its answer, so Submit sends them on the ANSWER path, marked as
   * the person's own words, and nothing leaves on the message path.
   */
  it('answers a held question with the person’s own words, never as a message', async () => {
    const wrapper = card()
    await writeOther(wrapper, 'use whatever is already there')
    expect(submitButton(wrapper).text()).toBe(SUBMIT_ANSWERS_NAME)
    expect(submitButton(wrapper).text()).not.toBe(SEND_OTHER_NAME)
    await submit(wrapper)
    expect(wrapper.emitted('answer')).toEqual([[[{ ownWords: 'use whatever is already there' }]]])
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })

  // ADDED for #635 (PO decision 2026-09-28, held free-text answers).
  it('submits a held walk with a step answered in words, one value per step', async () => {
    const wrapper = card({ question: several() })
    await writeOther(wrapper, '  a quince  ')
    await wrapper.find('.dm-qcard__next').trigger('click')
    await options(wrapper)[0]!.trigger('click')
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
    await submit(wrapper)
    expect(wrapper.emitted('answer')).toEqual([[[{ ownWords: 'a quince' }, 'East']]])
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })

  // AMENDED for #635 (was: Shift+Enter kept a newline): the field is one line, and Enter in it
  // moves to the next step at most — it never sends (components.md, Question card, as built).
  it('never sends from the free-answer field on Enter', async () => {
    const wrapper = card()
    await writeOther(wrapper, 'one line')
    pressEnter(wrapper.find('.dm-qopt-other-field input').element)
    pressEnter(wrapper.find('.dm-qopt-other-field input').element, true)
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })

  it('disables every choice while an answer is in flight', async () => {
    const wrapper = card({ answerState: { phase: 'answering', toolUseId: 'toolu_01' } })
    for (const option of options(wrapper)) {
      expect(option.attributes('disabled')).toBeDefined()
    }
    await options(wrapper)[0]!.trigger('click')
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('draws no alert for a refusal and lets the answer be tried again', async () => {
    const wrapper = card({
      answerState: {
        phase: 'refused',
        toolUseId: 'toolu_01',
        error: 'That session is not one this panel is holding.'
      }
    })
    // AMENDED for #635 (MESSAGE-QUESTIONS 21; was: main's reason in the card's alert row): the card draws no alert; the reason is the ✕ title on the "Answers:" record.
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
    for (const option of options(wrapper)) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
    await options(wrapper)[0]!.trigger('click')
    await submit(wrapper)
    expect(wrapper.emitted('answer')).toEqual([['Postgres']])
  })

  it('says the agent was handed the choice, never that it acted on it', () => {
    const wrapper = card({ answerState: { phase: 'answered', toolUseId: 'toolu_01' } })
    expect(wrapper.find('.dm-qcard__ok').text()).toContain('released')
    expect(wrapper.find('.dm-qcard__ok').text()).not.toMatch(/reacted|acted on/i)
  })

  it('keeps the question on screen after the answer was released', async () => {
    // The card is drawn from the dwarf's own pendingQuestion, and only main's
    // next snapshot may drop it. Hiding it here would claim the ask was closed
    // on the strength of the panel's own optimism.
    const wrapper = card()
    await options(wrapper)[0]!.trigger('click')
    await submit(wrapper)
    await wrapper.setProps({ answerState: { phase: 'answered', toolUseId: 'toolu_01' } })
    expect(wrapper.find('.dm-qcard__q').exists()).toBe(true)
    expect(options(wrapper)).toHaveLength(3)
  })

  it('does not offer to answer an ask that was already released', async () => {
    const wrapper = card({ answerState: { phase: 'answered', toolUseId: 'toolu_01' } })
    for (const option of options(wrapper)) {
      expect(option.attributes('disabled')).toBeDefined()
    }
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    await submit(wrapper)
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('never shows one ask’s verdict against the next one', async () => {
    const wrapper = card({ answerState: { phase: 'answered', toolUseId: 'toolu_01' } })
    await wrapper.setProps({ question: question({ toolUseId: 'toolu_02' }) })
    expect(wrapper.find('.dm-qcard__ok').exists()).toBe(false)
    for (const option of options(wrapper)) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
  })

  it('starts a new ask unselected, whatever was chosen for the last one', async () => {
    const wrapper = card()
    await options(wrapper)[0]!.trigger('click')
    await wrapper.setProps({ question: question({ toolUseId: 'toolu_02' }) })
    expect(checked(wrapper)).toEqual(['false', 'false', 'false'])
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
      expect(wrapper.find('.dm-qcard__header').text()).toBe('Storage')
      expect(wrapper.find('.dm-qcard__q').text()).toBe(
        'Which database should the importer write to?'
      )
      expect(options(wrapper)).toHaveLength(3)
    })

    // AMENDED for #635 (was: no "Press ENTER" line): Submit is drawn, and never wakes.
    it('makes no option selectable', async () => {
      const wrapper = observed()
      for (const option of options(wrapper)) {
        expect(option.attributes('disabled')).toBeDefined()
        expect(option.attributes('aria-checked')).toBe('false')
      }
      await options(wrapper)[0]!.trigger('click')
      expect(checked(wrapper)).toEqual(['false', 'false', 'false'])
      expect(wrapper.emitted('answer')).toBeUndefined()
      expect(wrapper.find('.dm-qcard__next').attributes('disabled')).toBeUndefined()
    })

    it('says where the answer goes in the runtime’s own words, not a second copy', () => {
      expect(observed().find('.dm-qcard__alert').text()).toContain(ANSWER_ONLY_WHERE_IT_RUNS)
    })

    // AMENDED for #635 (was: the jump inside the refusal row): it is the walk's own link now.
    it('offers exactly one jump, drawn as the permission card draws it', () => {
      const jumps = observed().findAll('.dm-qcard__jump')
      expect(jumps).toHaveLength(1)
      expect(jumps[0]!.text()).toBe(JUMP_TO_TERMINAL_NAME)
      expect(jumps[0]!.attributes('title')).toBe(CONSOLE_HINT)
    })

    it('asks for the console when the jump is pressed', async () => {
      const wrapper = observed()
      await wrapper.find('.dm-qcard__jump').trigger('click')
      expect(wrapper.emitted('open-console')).toHaveLength(1)
    })

    it('leaves the jump on the keyboard’s path while the options are off it', () => {
      // A disabled button is skipped by the browser's own tab order, so the
      // jump being an ordinary enabled button is the whole of what this needs.
      const jump = observed().find('.dm-qcard__jump')
      expect(jump.element.tagName).toBe('BUTTON')
      expect(jump.attributes('type')).toBe('button')
      expect(jump.attributes('disabled')).toBeUndefined()
    })

    it('sends nothing on Enter, and does not swallow the key', () => {
      const wrapper = observed()
      const event = pressEnter(wrapper.find('.dm-qcard').element)
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
    // AMENDED for #635 (was: no `.freeform-input`): the "Other thing…" row is drawn, closed.
    it('offers no free-text box, because the picker there would read it', async () => {
      const wrapper = observed()
      expect(otherRow(wrapper).attributes('disabled')).toBeDefined()
      await otherRow(wrapper).trigger('click')
      expect(wrapper.find('.dm-qopt-other-field').exists()).toBe(false)
      expect(wrapper.find('.dm-qcard__closed').text()).toContain(TYPED_HERE_REACHES_THE_PICKER)
    })

    it('says several questions, and names no provider (#360)', () => {
      // #360: the sentence used to tell the reader about "a Codex thread" on a
      // card that is drawn for an observed Claude session just as often.
      const text = observed().find('.dm-qcard__alert').text()
      expect(text).toContain('several questions')
      expect(text).not.toMatch(/codex|claude|gemini/i)
    })

    /*
     * AMENDED for #635 (was: 'leaves a held session’s question answerable, with no jump beside
     * it'). The design draws Jump to terminal in the walk of every state (components.md, Question
     * card, as built); it does what the header's Open console does. Still answerable, still no
     * refusal row.
     */
    it('leaves a held session’s question answerable, with no refusal row', async () => {
      const wrapper = card()
      for (const option of options(wrapper)) {
        expect(option.attributes('disabled')).toBeUndefined()
      }
      expect(wrapper.findAll('.dm-qcard__jump')).toHaveLength(1)
      expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
      await options(wrapper)[1]!.trigger('click')
      await submit(wrapper)
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
    for (const option of options(wrapper)) {
      expect(option.attributes('disabled')).toBeUndefined()
    }
    await options(wrapper)[1]!.trigger('click')
    expect(options(wrapper)[1]!.attributes('aria-checked')).toBe('true')
  })

  // AMENDED for #635 (was: on Enter): Submit is the one send.
  it('sends the chosen option on Submit, as the held channel does', async () => {
    const wrapper = observedSingle()
    await options(wrapper)[2]!.trigger('click')
    await submit(wrapper)
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
  // AMENDED for #635 (was: `.answer-error`, with its own jump): the jump is the walk's one link.
  it('draws no refusal row, and no jump belonging to one, while it can be answered', () => {
    const wrapper = observedSingle()
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
    expect(wrapper.findAll('.dm-qcard__jump')).toHaveLength(1)
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
  // AMENDED for #635 (was: `.freeform-input` present): the "Other thing…" row opens the field.
  it('offers the box back, because the picker’s own Other row is measured', async () => {
    const wrapper = observedSingle()
    expect(otherRow(wrapper).attributes('disabled')).toBeUndefined()
    await otherRow(wrapper).trigger('click')
    expect(wrapper.find('.dm-qopt-other-field').exists()).toBe(true)
    expect(wrapper.find('.dm-qcard__closed').exists()).toBe(false)
  })

  /*
   * AMENDED for #635 (was: Enter in the box sent it). Here the words ARE the answer, so Submit
   * keeps its name and sends them (components.md: a step answered this way counts as answered).
   */
  it('sends what was typed as an ANSWER, never on the message path', async () => {
    // THE repair. The words are typed into the row the agent's own picker
    // offers for them; they must not leave as a message, which on this channel
    // writes into the same console the picker is drawn in.
    const wrapper = observedSingle()
    await writeOther(wrapper, 'put it in Redis')
    expect(submitButton(wrapper).text()).toBe(SUBMIT_ANSWERS_NAME)
    await submit(wrapper)
    expect(wrapper.emitted('answer-text')).toEqual([['put it in Redis']])
    expect(wrapper.emitted('send-text')).toBeUndefined()
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  // AMENDED for #635 (was: Shift+Enter kept a newline): Enter in the field never sends.
  it('never sends a typed answer on Enter, Submit being the one send', async () => {
    const wrapper = observedSingle()
    await writeOther(wrapper, 'one line')
    pressEnter(wrapper.find('.dm-qopt-other-field input').element)
    pressEnter(wrapper.find('.dm-qopt-other-field input').element, true)
    expect(wrapper.emitted('answer-text')).toBeUndefined()
  })

  // AMENDED for #635 (was: Enter on a blank box): a blank field answers nothing, so Submit sleeps.
  it('sends nothing for an empty box', async () => {
    const wrapper = observedSingle()
    await writeOther(wrapper, '   ')
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    await submit(wrapper)
    expect(wrapper.emitted('answer-text')).toBeUndefined()
  })

  // AMENDED for #635 (was: typing into an open box): the row is closed while one is in flight.
  it('sends no typed answer while one is already in flight', async () => {
    // A second release of the same blocked tool call, from the one control on
    // the card that is not a disabled button.
    const wrapper = observedSingle()
    await writeOther(wrapper, 'put it in Redis')
    await wrapper.setProps({ answerState: { phase: 'answering', toolUseId: 'toolu_01' } })
    expect(otherRow(wrapper).attributes('disabled')).toBeDefined()
    await submit(wrapper)
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
    const text = refused.find('.dm-qcard__closed').text()
    expect(text).toMatch(/picker/i)
    expect(text).toMatch(/terminal/i)
    expect(text).not.toMatch(/codex|claude|gemini/i)
  })

  /*
   * AMENDED for #481 item 3 (was: 'offers the way to that terminal beside the
   * refused box', read off `observedSingle`). Re-aimed at the same still-refused
   * shape, for the same reason as the case above, and asserting exactly what it
   * asserted before.
   * AMENDED for #635 (was: the jump inside `.freeform-refused`): the card's one jump is the
   * walk's Jump to terminal, which the refused row's sentence sends the person to.
   */
  it('offers the way to that terminal beside a box it still refuses', async () => {
    const refused = card({ question: question({ channel: 'terminal', multiSelect: true }) })
    const jump = refused.find('.dm-qcard__jump')
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
    // AMENDED for #635 (was: Enter in the box, then Enter on a choice): both through Submit.
    const wrapper = observedSingle()
    await writeOther(wrapper, 'put it in Redis')
    await submit(wrapper)
    await options(wrapper)[0]!.trigger('click')
    await submit(wrapper)
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })

  it('refuses the box for an ask with more options than the picker numbers', () => {
    // The digit runs out at nine and the rows may scroll past them, which is
    // exactly where the counted reach stops being derivable from what was
    // measured — so the sentence, not a guess.
    const eleven = Array.from({ length: 11 }, (_, index) => ({ label: `Option ${index + 1}` }))
    const wrapper = card({ question: question({ channel: 'terminal', options: eleven }) })
    expect(otherRow(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.find('.dm-qcard__closed').text()).toContain(TYPED_HERE_REACHES_THE_PICKER)
  })

  it('keeps the box on a held session’s ask, whose text touches no picker', () => {
    // #125's path is untouched: those words are queued on the stream this panel
    // holds, so nothing about them reaches a TUI.
    const wrapper = card()
    expect(otherRow(wrapper).attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.dm-qcard__closed').exists()).toBe(false)
  })

  it('keeps the way to the terminal after a refusal, with no alert', async () => {
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
    // AMENDED for #635 (MESSAGE-QUESTIONS 21; was: main's reason in the card's alert row): the card draws no alert; the reason is the ✕ title on the "Answers:" record.
    expect(wrapper.find('.dm-qcard__alert').exists()).toBe(false)
    expect(wrapper.find('.dm-qcard__jump').exists()).toBe(true)
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

  // AMENDED for #635 (was: `is-selected` and `is-base` classes): read off aria-checked.
  it('keeps every toggled option selected, dimming none of the others', async () => {
    const wrapper = multi()
    await options(wrapper)[0]!.trigger('click')
    await options(wrapper)[2]!.trigger('click')
    expect(checked(wrapper)).toEqual(['true', 'false', 'true'])
  })

  // AMENDED for #635 (was: aria-pressed on a button): a toggle is a checkbox, checked or not.
  it('reports every toggle to a screen reader as checked', async () => {
    const wrapper = multi()
    await options(wrapper)[1]!.trigger('click')
    expect(options(wrapper).map((o) => o.attributes('role'))).toEqual([
      'checkbox',
      'checkbox',
      'checkbox'
    ])
    expect(checked(wrapper)).toEqual(['false', 'true', 'false'])
  })

  // AMENDED for #635 (was: no Answer control): the walk's Submit goes back to sleep.
  it('turns a toggle off again when it is clicked twice', async () => {
    const wrapper = multi()
    const first = options(wrapper)[0]!
    await first.trigger('click')
    await first.trigger('click')
    expect(first.attributes('aria-checked')).toBe('false')
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
  })

  /*
   * AMENDED for #635 (was: an "Answer" control drawn once something is toggled). The design's
   * walk has one Submit, which wakes once the step is answered; a toggling ask sends through it.
   */
  it('wakes Submit only once something is toggled', async () => {
    const wrapper = multi()
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    await options(wrapper)[0]!.trigger('click')
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(submitButton(wrapper).text()).toBe(SUBMIT_ANSWERS_NAME)
  })

  it('sends nothing on a toggle, however many are on', async () => {
    // The whole reason the control exists: a toggle is not an answer, and the
    // panel must never type one into a console nobody has released.
    const wrapper = multi()
    await options(wrapper)[0]!.trigger('click')
    await options(wrapper)[1]!.trigger('click')
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  // AMENDED for #635 (was: the Answer control): Submit.
  it('emits once with every toggled label when Submit is pressed', async () => {
    const wrapper = multi()
    await options(wrapper)[2]!.trigger('click')
    await options(wrapper)[0]!.trigger('click')
    await submit(wrapper)

    // In the ask's OWN option order, not the order they were clicked: main
    // presses a digit per option position.
    expect(wrapper.emitted('answer')).toEqual([[joinAnswerLabels(['Postgres', 'Neither'])]])
  })

  it('does not send on Enter: this ask has a control of its own', async () => {
    const wrapper = multi()
    await options(wrapper)[0]!.trigger('click')
    const event = pressEnter(wrapper.find('.dm-qcard').element)
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
  // AMENDED for #635 (was: no `.freeform-input`): the "Other thing…" row is drawn, closed.
  it('offers no free-text box either, toggled or not', async () => {
    const wrapper = multi()
    expect(otherRow(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.find('.dm-qcard__closed').text()).toContain(TYPED_HERE_REACHES_THE_PICKER)
    await options(wrapper)[0]!.trigger('click')
    expect(wrapper.emitted('send-text')).toBeUndefined()
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  // AMENDED for #635 (was: no Answer control drawn): Submit stays asleep.
  it('takes no toggle and offers no control while an answer is in flight', async () => {
    const wrapper = multi({ toolUseId: 'toolu_01' })
    await wrapper.setProps({ answerState: { phase: 'answering', toolUseId: 'toolu_01' } })
    for (const option of options(wrapper)) {
      expect(option.attributes('disabled')).toBeDefined()
    }
    await options(wrapper)[0]!.trigger('click')
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('starts a new ask with nothing toggled', async () => {
    const wrapper = multi()
    await options(wrapper)[0]!.trigger('click')
    await wrapper.setProps({
      question: question({ channel: 'terminal', multiSelect: true, toolUseId: 'toolu_02' })
    })
    expect(checked(wrapper)).toEqual(['false', 'false', 'false'])
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
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
  // AMENDED for #635 (was: no `.freeform-input`): the row is closed and opens no field.
  it('never offers the free-text box for a route the union does not name as safe (F2)', async () => {
    const wrapper = card({ question: question({ channel: 'opencode-permission' }) })
    expect(otherRow(wrapper).attributes('disabled')).toBeDefined()
    await otherRow(wrapper).trigger('click')
    expect(wrapper.find('.dm-qopt-other-field').exists()).toBe(false)
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
  // AMENDED for #635 (was: the Answer control): through the walk's Submit.
  it('toggles a HELD multi-select ask and sends every toggle through Submit', async () => {
    const wrapper = card({ question: question({ multiSelect: true }) })
    await options(wrapper)[0]!.trigger('click')
    await options(wrapper)[1]!.trigger('click')
    expect(checked(wrapper)).toEqual(['true', 'true', 'false'])
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
    await submit(wrapper)
    expect(wrapper.emitted('answer')).toEqual([[joinAnswerLabels(['Postgres', 'SQLite'])]])
  })

  it('sends nothing on a HELD multi-select ask with zero toggles', () => {
    const wrapper = card({ question: question({ multiSelect: true }) })
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    const event = pressEnter(wrapper.find('.dm-qcard').element)
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
    await wrapper.find('.dm-qcard__next').trigger('click')
  }

  async function back(wrapper: ReturnType<typeof card>) {
    await wrapper.find('.dm-qcard__back').trigger('click')
  }

  /*
   * AMENDED for #635 (was: 'draws none of the walk for a one-question call'). The design walks a
   * one-step card the same way, exactly as its Permission state draws it: "1 / 1", Back disabled
   * as on every first step, one dot, Jump to terminal, and Submit; Next hidden as on every last
   * step (components.md, Question card, as built).
   */
  it('walks a one-question call as a walk of one step', () => {
    const wrapper = card()
    expect(wrapper.find('.dm-qcard__step').text()).toBe('1 / 1')
    expect(wrapper.find('.dm-qcard__back').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('.dm-qcard__dots i')).toHaveLength(1)
    expect(wrapper.find('.dm-qcard__next').exists()).toBe(false)
    expect(submitButton(wrapper).exists()).toBe(true)
  })

  // AMENDED for #635 (was: "Question 1 of 2" above the question): the head's step count.
  it('shows question 1 of n first, with its own header and options', () => {
    const wrapper = walk()
    expect(wrapper.find('.dm-qcard__step').text()).toBe('1 / 2')
    expect(wrapper.find('.dm-qcard__header').text()).toBe('Storage')
    expect(wrapper.find('.dm-qcard__q').text()).toBe('Which database?')
    expect(labelsOf(wrapper)).toEqual(['Postgres', 'SQLite'])
  })

  /*
   * AMENDED for #635 (was: Next pressed on an unanswered question). The design's Next wakes once
   * the step is answered (components.md, Question card: `next.disabled = !answered(i)`), so the
   * walk picks first; a call nothing here can answer still walks freely (the terminal block below).
   */
  it('moves to the next question and back again', async () => {
    const wrapper = walk()
    expect(wrapper.find('.dm-qcard__next').attributes('disabled')).toBeDefined()
    await options(wrapper)[0]!.trigger('click')
    await next(wrapper)
    expect(wrapper.find('.dm-qcard__step').text()).toBe('2 / 2')
    expect(wrapper.find('.dm-qcard__header').text()).toBe('Regions')
    expect(wrapper.find('.dm-qcard__q').text()).toBe('Which regions?')
    expect(options(wrapper)).toHaveLength(3)
    await back(wrapper)
    expect(wrapper.find('.dm-qcard__q').text()).toBe('Which database?')
  })

  // AMENDED for #635 (was: Next disabled on the last question): it is hidden there, as designed.
  it('offers no Back on the first question and no Next on the last', async () => {
    const wrapper = walk()
    expect(wrapper.find('.dm-qcard__back').attributes('disabled')).toBeDefined()
    await options(wrapper)[0]!.trigger('click')
    expect(wrapper.find('.dm-qcard__next').attributes('disabled')).toBeUndefined()
    await next(wrapper)
    expect(wrapper.find('.dm-qcard__back').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.dm-qcard__next').exists()).toBe(false)
  })

  it('draws the Submit only on the last question', async () => {
    const wrapper = walk()
    expect(submitButton(wrapper).exists()).toBe(false)
    await options(wrapper)[0]!.trigger('click')
    await next(wrapper)
    expect(submitButton(wrapper).text()).toBe(SUBMIT_ANSWERS_NAME)
  })

  // AMENDED for #635 (was: Next past an unanswered question): the card opens on the last step.
  it('cannot submit while any question is unanswered', async () => {
    const wrapper = card({ question: pair(), at: 1 })
    await options(wrapper)[1]!.trigger('click')
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    await submit(wrapper)
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('never shows a choice made on question 1 on question 2', async () => {
    const wrapper = walk()
    await options(wrapper)[0]!.trigger('click')
    await next(wrapper)
    expect(checked(wrapper)).toEqual(['false', 'false', 'false'])
  })

  // AMENDED for #635 (was: the other option dimmed): it is simply not picked.
  it('keeps a choice on its own question when the walk comes back to it', async () => {
    const wrapper = walk()
    await options(wrapper)[1]!.trigger('click')
    await next(wrapper)
    await back(wrapper)
    expect(checked(wrapper)).toEqual(['false', 'true'])
  })

  it('starts another ask on its first question with nothing chosen', async () => {
    const wrapper = walk()
    await options(wrapper)[0]!.trigger('click')
    await next(wrapper)
    await wrapper.setProps({ question: pair({ toolUseId: 'toolu_02' }) })
    expect(wrapper.find('.dm-qcard__step').text()).toBe('1 / 2')
    expect(checked(wrapper)).toEqual(['false', 'false'])
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
    await options(wrapper)[0]!.trigger('click')
    await next(wrapper)
    await options(wrapper)[2]!.trigger('click')
    await options(wrapper)[1]!.trigger('click')
    expect(submitButton(wrapper).attributes('disabled')).toBeUndefined()
    await submit(wrapper)
    expect(wrapper.emitted('answer')).toEqual([[['Postgres', joinAnswerLabels(['West', 'North'])]]])
  })

  it('sends nothing on Enter: the walk has a Submit of its own', async () => {
    const wrapper = walk()
    await options(wrapper)[0]!.trigger('click')
    await next(wrapper)
    await options(wrapper)[0]!.trigger('click')
    const event = pressEnter(wrapper.find('.dm-qcard').element)
    expect(wrapper.emitted('answer')).toBeUndefined()
    expect(event.defaultPrevented).toBe(false)
  })

  it('takes no Submit while an answer is already in flight', async () => {
    const wrapper = walk()
    await options(wrapper)[0]!.trigger('click')
    await next(wrapper)
    await options(wrapper)[0]!.trigger('click')
    await wrapper.setProps({ answerState: { phase: 'answering', toolUseId: 'toolu_01' } })
    expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
    await submit(wrapper)
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  describe('at a terminal, where the walk between questions is unmeasured', () => {
    it('can be walked to read every question', async () => {
      const wrapper = walk({ channel: 'terminal' })
      expect(wrapper.find('.dm-qcard__next').attributes('disabled')).toBeUndefined()
      await next(wrapper)
      expect(wrapper.find('.dm-qcard__q').text()).toBe('Which regions?')
      await back(wrapper)
      expect(wrapper.find('.dm-qcard__q').text()).toBe('Which database?')
    })

    // AMENDED for #635 (was: no Submit drawn): the design's last step draws it, asleep.
    it('makes nothing selectable on any question, and offers no Submit that wakes', async () => {
      const wrapper = walk({ channel: 'terminal' })
      for (const step of [0, 1]) {
        if (step === 1) await next(wrapper)
        for (const option of options(wrapper)) {
          expect(option.attributes('disabled')).toBeDefined()
          await option.trigger('click')
          expect(option.attributes('aria-checked')).toBe('false')
        }
      }
      expect(submitButton(wrapper).attributes('disabled')).toBeDefined()
      await submit(wrapper)
      expect(wrapper.emitted('answer')).toBeUndefined()
    })

    it('keeps the one refusal and the one jump on every question', async () => {
      const wrapper = walk({ channel: 'terminal' })
      await next(wrapper)
      expect(wrapper.find('.dm-qcard__alert').text()).toContain(ANSWER_ONLY_WHERE_IT_RUNS)
      expect(wrapper.findAll('.dm-qcard__jump')).toHaveLength(1)
    })
  })
})

/*
 * ADDED for #635: an input method's own Enter picks its candidate, and the text it belongs to is
 * not written yet — the composer's rule (belongsToComposition, lib/controls/input), which the
 * free-answer box ignored.
 */
describe('an Enter that belongs to an IME composition', () => {
  function composingEnter(element: Element, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...init
    })
    element.dispatchEvent(event)
    return event
  }

  // AMENDED for #635 (was: the old always-open box): the field "Other thing…" opens.
  it('sends nothing from the free-answer box while the composition is open', async () => {
    const wrapper = card()
    await writeOther(wrapper, 'にほんご')
    const field = wrapper.find('.dm-qopt-other-field input').element
    composingEnter(field, { isComposing: true })
    composingEnter(field, { keyCode: 229 })
    expect(wrapper.emitted('send-text')).toBeUndefined()
    expect(wrapper.emitted('answer-text')).toBeUndefined()
  })

  // ADDED for #635: in the field an Enter moves to the next step once answered — never mid-word.
  it('does not move the walk on while the composition is open', async () => {
    const wrapper = card({ question: several() })
    await writeOther(wrapper, 'にほんご')
    const field = wrapper.find('.dm-qopt-other-field input').element
    composingEnter(field, { isComposing: true })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dm-qcard__step').text()).toBe('1 / 2')
    composingEnter(field, { keyCode: 229 })
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dm-qcard__step').text()).toBe('1 / 2')
    composingEnter(field, {})
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dm-qcard__step').text()).toBe('2 / 2')
  })
})

/*
 * ADDED for #635: the design's card (components.md, Question card, as built; accessibility.md,
 * Keyboard): the head, the walk, the digit keys and where focus goes.
 */
describe('the question card as the design draws it (#635)', () => {
  function three() {
    return card({
      question: question({
        questions: [
          {
            question: 'Which database?',
            multiSelect: false,
            options: [{ label: 'A' }, { label: 'B' }]
          },
          { question: 'Which region?', multiSelect: false, options: [{ label: 'East' }] },
          { question: 'Run it?', multiSelect: false, options: [{ label: 'Yes' }] }
        ]
      })
    })
  }

  it('is named for its asker, and its head reads "? asks" with the step count', () => {
    const wrapper = three()
    expect(wrapper.find('section.dm-qcard').attributes('aria-label')).toBe('dwarfai-54 is asking')
    const pill = wrapper.find('.dm-qcard__head .dm-pill--needs')
    expect(pill.find('.dm-pill__q').text()).toBe('?')
    expect(pill.text()).toBe('?asks')
    expect(wrapper.find('.dm-qcard__step').text()).toBe('1 / 3')
  })

  it('makes each step a radiogroup named by its question', () => {
    const group = three().find('.dm-qcard__opts')
    expect(group.attributes('role')).toBe('radiogroup')
    expect(group.attributes('aria-label')).toBe('Which database?')
    expect(group.findAll('[role="radio"]')).toHaveLength(3)
  })

  it('shows each option’s number key, "Other thing…" last', () => {
    const keys = three()
      .findAll('.dm-qopt__key')
      .map((k) => k.text())
    expect(keys).toEqual(['1', '2', '3'])
  })

  it('draws the walk in the design’s order: Back, the dots, Jump to terminal, then Next', () => {
    const walk = three().find('.dm-qcard__walk')
    const order = walk
      .findAll(':scope > *')
      .map((child) =>
        [
          'dm-qcard__back',
          'dm-qcard__dots',
          'dm-qcard__jump',
          'dm-qcard__next',
          'dm-qcard__submit'
        ].find((name) => child.classes().includes(name))
      )
      .filter((name) => name !== undefined)
    expect(order).toEqual(['dm-qcard__back', 'dm-qcard__dots', 'dm-qcard__jump', 'dm-qcard__next'])
  })

  it('marks the step shown here, each answered step done, and the rest open', async () => {
    const wrapper = three()
    const dots = () => wrapper.findAll('.dm-qcard__dots i').map((dot) => dot.classes().join(' '))
    expect(dots()).toEqual(['is-here', '', ''])
    await options(wrapper)[0]!.trigger('click')
    await wrapper.find('.dm-qcard__next').trigger('click')
    expect(dots()).toEqual(['is-done', 'is-here', ''])
  })

  it('picks with the digit keys, "Other thing…" one past the options, and never sends', async () => {
    const wrapper = three()
    pressKey(wrapper.find('.dm-qcard').element, '2')
    await wrapper.vm.$nextTick()
    expect(checked(wrapper)).toEqual(['false', 'true'])
    pressKey(wrapper.find('.dm-qcard').element, '3')
    await wrapper.vm.$nextTick()
    expect(otherRow(wrapper).attributes('aria-checked')).toBe('true')
    // One answer per step: the words take the option's place.
    expect(checked(wrapper)).toEqual(['false', 'false'])
    expect(document.activeElement).toBe(wrapper.find('.dm-qopt-other-field input').element)
    expect(wrapper.emitted('answer')).toBeUndefined()
  })

  it('reads no digit typed into the free-answer field as a pick', async () => {
    const wrapper = three()
    await writeOther(wrapper, 'take 1')
    const event = pressKey(wrapper.find('.dm-qopt-other-field input').element, '1')
    await wrapper.vm.$nextTick()
    expect(event.defaultPrevented).toBe(false)
    expect(checked(wrapper)).toEqual(['false', 'false'])
    expect(otherRow(wrapper).attributes('aria-checked')).toBe('true')
  })

  it('moves to the next step on Enter on an answered row, never re-picking it', async () => {
    const wrapper = three()
    await options(wrapper)[1]!.trigger('click')
    const event = pressEnter(options(wrapper)[1]!.element)
    await wrapper.vm.$nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.find('.dm-qcard__step').text()).toBe('2 / 3')
  })

  it('takes focus to the row a pick lands on, and to the answer when a step is walked to', async () => {
    const wrapper = three()
    pressKey(wrapper.find('.dm-qcard').element, '2')
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(options(wrapper)[1]!.element)
    await wrapper.find('.dm-qcard__next').trigger('click')
    await wrapper.find('.dm-qcard__back').trigger('click')
    expect(document.activeElement).toBe(options(wrapper)[1]!.element)
  })

  /*
   * ADDED for #635: on a question "Other thing…" answers its step (screens/message.md, Question
   * card, as built) — the walk goes on with Next, never a Send in its place, and the step counts as
   * answered only while the field holds text.
   */
  it('walks on from a step answered in the person’s own words, with Next and never Send', async () => {
    const wrapper = three()
    await writeOther(wrapper, '   ')
    expect(wrapper.find('.dm-qcard__next').attributes('disabled')).toBeDefined()
    expect(submitButton(wrapper).exists()).toBe(false)
    await wrapper.find('.dm-qopt-other-field input').setValue('Redis')
    expect(wrapper.find('.dm-qcard__next').attributes('disabled')).toBeUndefined()
    expect(submitButton(wrapper).exists()).toBe(false)
    pressEnter(wrapper.find('.dm-qopt-other-field input').element)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dm-qcard__step').text()).toBe('2 / 3')
    expect(wrapper.findAll('.dm-qcard__dots i').map((dot) => dot.classes().join(' '))).toEqual([
      'is-done',
      'is-here',
      ''
    ])
    expect(wrapper.emitted('send-text')).toBeUndefined()
  })

  it('opens on the step and with the answers its host hands it', () => {
    const wrapper = card({ question: several(), at: 1, answers: ['SQLite'] })
    expect(wrapper.find('.dm-qcard__step').text()).toBe('2 / 2')
    expect(wrapper.findAll('.dm-qcard__dots i').map((dot) => dot.classes().join(' '))).toEqual([
      'is-done',
      'is-here'
    ])
  })
})
