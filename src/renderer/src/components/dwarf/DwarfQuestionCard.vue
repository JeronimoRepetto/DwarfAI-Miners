<script setup lang="ts">
import { computed, ref } from 'vue'
import { CONSOLE_HINT, JUMP_TO_TERMINAL_NAME } from '../../lib/delivery/actionBar'
import {
  PRESS_ENTER_TO_SEND,
  SEND_ANSWER_NAME,
  answerStatusLine,
  answerStateForAsk,
  canSendAnswer,
  canSendToggles,
  isAnswerable,
  optionState,
  selectOption,
  toggleOption,
  toggleState,
  toggledAnswer,
  type QuestionSelection,
  type QuestionToggles
} from '../../lib/question/questionAnswer'
import {
  ANSWER_ONLY_WHERE_IT_RUNS,
  MAX_DWARF_TEXT_CHARS,
  type DwarfAnswerState,
  type DwarfQuestion
} from '../../types'

/**
 * What an agent asked its user, and the answers it said it would take (#125).
 *
 * Thin, like every component here: which card is selected, whether Enter would
 * send and what an answer carries are all decided in lib/question.
 *
 * An ask on the terminal channel used to be drawn but not offered (#354). Since
 * #362 it is answered by keystroke at the console the session runs in, so what
 * is left unanswerable is narrower and the card still reads it off the wire
 * rather than deriving it: `questionCount > 1` on that channel, because only
 * the first question of a call travels and answering it walks the picker on to
 * one nothing here knows about. Then the header, the question and every option
 * stay exactly where they are, the options go inert, and one jump to the
 * session's own terminal appears under main's own sentence — the same control,
 * in the same place, as the permission card's refused terminal decision. Both
 * fields are exactly what main's `answerDwarfQuestion` guards on, so the card
 * cannot offer an answer main would refuse.
 *
 * A MULTI-SELECT ask on that channel is the one place the gesture differs, and
 * the channel decides it because the EVIDENCE differs rather than because the
 * ask does. The terminal gesture is measured — one digit per chosen option,
 * then a confirmation — so several labels can be sent, the options become
 * toggles, and an explicit Answer control releases them: nothing is typed into
 * somebody's console until they say so. On the held channel the same ask keeps
 * the single-choice gesture it always had, because how the agent's own picker
 * joins several answers is unmeasured (see resolveAnswers in main).
 *
 * Two things this component deliberately does NOT do. It never hides the
 * question — the card is drawn from the dwarf's own `pendingQuestion`, and only
 * main's next snapshot may drop it, so a panel that cleared it on send would be
 * claiming the ask was closed on the strength of its own optimism. And it never
 * sends free-form text as an ANSWER: the answer channel takes back only the
 * agent's own words, so anything typed here leaves on the ordinary message
 * path instead (see the emits below).
 */

const props = defineProps<{
  question: DwarfQuestion
  /** The verdict of the last answer given for this dwarf, whatever ask it named. */
  answerState?: DwarfAnswerState
}>()

const emit = defineEmits<{
  /** Answer the ask with one of its own option labels. */
  answer: [label: string]
  /** A free-form reply, which travels as a message rather than as an answer. */
  'send-text': [payload: { text: string; pressEnter: boolean }]
  /** Focus the console the session runs in, where an unanswerable ask waits. */
  'open-console': []
}>()

const selection = ref<QuestionSelection | null>(null)
const toggles = ref<QuestionToggles | null>(null)
const freeform = ref('')

/** The verdict only where it belongs: a new ask never wears the last one's. */
const verdict = computed(() => answerStateForAsk(props.answerState, props.question.toolUseId))
/*
 * An ask nothing here can answer, known before anybody clicks (#354, #362).
 * Off the wire rather than off the dwarf, because the wire is where main put
 * the two readings its own guard uses — see DwarfPromptChannel and
 * DwarfQuestion.questionCount.
 */
const unanswerable = computed(
  () => props.question.channel === 'terminal' && props.question.questionCount > 1
)
/*
 * Whether this ask's options are toggles rather than one choice (#362). The
 * channel, not just `multiSelect`: only the terminal gesture for several
 * answers has been measured — see the module comment.
 */
const toggling = computed(() => props.question.channel === 'terminal' && props.question.multiSelect)
const answerable = computed(
  () => !unanswerable.value && isAnswerable(props.answerState, props.question.toolUseId)
)
const canSend = computed(
  () =>
    !unanswerable.value &&
    !toggling.value &&
    canSendAnswer(selection.value, props.question.toolUseId, props.answerState)
)
/** Whether the Answer control is there to press, which is the toggling ask's own send. */
const canAnswerToggles = computed(
  () =>
    toggling.value &&
    !unanswerable.value &&
    canSendToggles(toggles.value, props.question.toolUseId, props.answerState)
)
const selectedLabel = computed(() =>
  selection.value?.toolUseId === props.question.toolUseId ? selection.value.label : null
)
const okLine = computed(() => answerStatusLine(verdict.value))
/*
 * One row for both refusals, because they are the same sentence in the same
 * place: main's, verbatim. The difference is only when it is known — an
 * unanswerable ask says it up front, a refused answer after the fact — and an
 * unanswerable ask wins, since no verdict of its own can exist while nothing
 * on it can be pressed.
 */
const refusalLine = computed(() => {
  if (unanswerable.value) return ANSWER_ONLY_WHERE_IT_RUNS
  return verdict.value?.phase === 'refused' ? verdict.value.error : null
})
/*
 * The jump belongs to a refusal about a CONSOLE, which is every refusal on the
 * terminal channel: an unanswerable several-question ask, and anything main
 * returned for one it could not type. A held session's refusal is about the
 * stream this panel owns, and there is nowhere to send the person for it.
 */
const showJump = computed(() => props.question.channel === 'terminal' && refusalLine.value !== null)

function cardClass(label: string): string {
  const state = toggling.value
    ? toggleState(toggles.value, props.question.toolUseId, label)
    : optionState(selection.value, props.question.toolUseId, label)
  return `is-${state}`
}

function isChosen(label: string): boolean {
  return toggling.value
    ? toggleState(toggles.value, props.question.toolUseId, label) === 'selected'
    : selectedLabel.value === label
}

function choose(label: string): void {
  if (!answerable.value) return
  if (toggling.value) {
    toggles.value = toggleOption(toggles.value, props.question.toolUseId, label)
    return
  }
  selection.value = selectOption(selection.value, props.question.toolUseId, label)
}

function submit(): void {
  if (!canSend.value || selectedLabel.value === null) return
  emit('answer', selectedLabel.value)
}

/** The toggling ask's send: every toggled label, in the ask's own option order. */
function answerToggles(): void {
  if (!canAnswerToggles.value) return
  const answer = toggledAnswer(toggles.value, props.question)
  if (answer === null) return
  emit('answer', answer)
}

/**
 * Enter sends the selection, and must CONSUME the key: the chosen card still
 * has focus, and the click a browser synthesises from Enter on a focused button
 * is the gesture that deselects it.
 *
 * A toggling ask is deliberately not here. What a toggle changes is a SET, so
 * there is no keypress that could mean "this is my answer now" — its Answer
 * control is the only thing that sends, and Enter on one of its options is
 * left to the browser as the ordinary click it is.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || !canSend.value) return
  event.preventDefault()
  submit()
}

/** The convention every composer here uses: Enter sends, Shift+Enter writes a newline. */
function onFreeformKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  const text = freeform.value.trim()
  if (text === '') return
  emit('send-text', { text, pressEnter: true })
  freeform.value = ''
}
</script>

<template>
  <div class="question-card" @keydown="onKeydown">
    <p v-if="question.header" class="question-header">{{ question.header }}</p>
    <p class="question-text">{{ question.question }}</p>

    <div class="options" role="group" aria-label="Answers this agent offered">
      <button
        v-for="option in question.options"
        :key="option.label"
        class="option-card"
        :class="cardClass(option.label)"
        type="button"
        :disabled="!answerable"
        :aria-pressed="isChosen(option.label) ? 'true' : 'false'"
        @click="choose(option.label)"
      >
        <span class="option-label">{{ option.label }}</span>
        <span v-if="option.description" class="option-description">{{ option.description }}</span>
      </button>
    </div>

    <p class="freeform-label">Other Thing</p>
    <!--
      Swapped for the send prompt once something is chosen, exactly as the
      design has it: one surface, saying either "type instead" or "press Enter".

      A toggling ask puts its Answer control in that same one surface, for the
      same reason the prompt is there rather than beside it: the card has one
      place that says what happens next, and a second row would make the panel
      look like it were offering two different sends (#362).
    -->
    <button v-if="canAnswerToggles" class="answer-send" type="button" @click="answerToggles()">
      {{ SEND_ANSWER_NAME }}
    </button>
    <p v-else-if="!toggling && selectedLabel !== null" class="enter-prompt" role="status">
      {{ PRESS_ENTER_TO_SEND }}
    </p>
    <textarea
      v-else
      v-model="freeform"
      class="freeform-input"
      rows="2"
      :maxlength="MAX_DWARF_TEXT_CHARS"
      placeholder="Write here..."
      aria-label="Answer this agent in your own words"
      @keydown="onFreeformKeydown"
    ></textarea>

    <p v-if="refusalLine" class="answer-error" role="alert">
      <span>{{ refusalLine }}</span>
      <!--
        The permission card's own jump, drawn the same way for the same act, so
        one affordance does not read as two. A disabled option is off the
        keyboard's path already; this button is the one thing on the card that
        still does something.
      -->
      <button
        v-if="showJump"
        class="answer-jump"
        type="button"
        :title="CONSOLE_HINT"
        @click="emit('open-console')"
      >
        {{ JUMP_TO_TERMINAL_NAME }}
      </button>
    </p>
    <p v-else-if="okLine" class="answer-ok" role="status">{{ okLine }}</p>
  </div>
</template>

<style scoped>
.question-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 210px;
  text-align: left;
}
.question-header {
  margin: 0;
  color: var(--color-accent);
  font-size: var(--text-meta);
  font-weight: 700;
}
/*
 * The agent message surface from the design: cream, accent border, dark ink.
 *
 * AMENDED for #347: the question is the agent SPEAKING, so it takes the
 * conversation face and size rather than the Pixel UI chrome around it. The
 * header above stays Tiny5 — that one is a headline, not a sentence.
 */
.question-text {
  overflow-y: auto;
  margin: 0;
  max-height: 96px;
  padding: 5px 6px;
  border: 1px solid var(--color-accent);
  border-radius: 12px;
  color: var(--color-panel);
  background: var(--color-cream);
  font-family: var(--font-conversation);
  font-size: var(--text-conversation);
  line-height: 1.35;
  user-select: text;
  -webkit-user-select: text;
}
.options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  max-height: 168px;
}
/*
 * The question option card's three states, in the design's own values. The
 * dimmed state's ink deliberately sits close to its background: a passed-over
 * option is still legible enough to reconsider and quiet enough to stop
 * competing with the chosen one.
 */
.option-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 6px;
  border: 1px solid var(--color-accent);
  border-radius: 12px;
  color: var(--color-panel);
  cursor: pointer;
  background: var(--color-cream);
  font: inherit;
  /*
   * #347: an option's label and its description are the agent's OWN words on
   * the agent's own cream surface, exactly like the question above — so the
   * whole card takes the conversation face rather than drawing the label in
   * one face and its sentence in another.
   */
  font-family: var(--font-conversation);
  font-size: var(--text-conversation);
  line-height: 1.3;
  text-align: left;
}
.option-card.is-selected {
  border-color: var(--color-cream);
  background: var(--color-accent);
}
.option-card.is-dimmed {
  border-color: var(--color-panel);
  background: var(--color-question-dark);
}
.option-card:disabled {
  cursor: not-allowed;
}
.option-card:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 1px;
}
.option-label {
  font-weight: 700;
}
.option-description {
  opacity: 0.85;
}
.freeform-label {
  margin: 2px 0 0;
  color: var(--color-cream);
  font-size: var(--text-meta);
  font-weight: 700;
}
.freeform-input {
  padding: 5px 6px;
  border: 1px solid var(--color-accent);
  border-radius: 12px;
  color: var(--color-panel);
  background: #fff;
  font: inherit;
  font-size: var(--text-meta);
  resize: none;
  user-select: text;
  -webkit-user-select: text;
}
.freeform-input:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 1px;
}
/* Same surface as the input it replaces, so the panel changes its message
   without changing its shape. */
.enter-prompt {
  margin: 0;
  padding: 9px 6px;
  border: 1px solid var(--color-accent);
  border-radius: 12px;
  color: var(--color-panel);
  background: var(--color-cream);
  font-size: var(--text-meta);
  font-weight: 700;
  text-align: center;
}
/*
 * The toggling ask's send (#362), in the enter-prompt's own place and its own
 * values — it says the same thing in the same surface, and the only difference
 * is that this one is pressed. Filled with the accent rather than the cream so
 * it reads as the one live control on a card whose options are all now
 * "chosen", the same inversion .option-card.is-selected uses.
 */
.answer-send {
  padding: 9px 6px;
  border: 1px solid var(--color-cream);
  border-radius: 12px;
  color: var(--color-cream);
  cursor: pointer;
  background: var(--color-accent);
  font: inherit;
  font-size: var(--text-meta);
  font-weight: 700;
  text-align: center;
}
.answer-send:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 1px;
}
.answer-error,
.answer-ok {
  margin: 0;
  font-size: var(--text-helper);
  line-height: 1.25;
}
.answer-error {
  display: flex;
  gap: 6px;
  align-items: baseline;
  color: #8c2f14;
}
/* The permission card's jump, to the character: the same underlined text
   button the MessagePanel's own approval line uses for the same act. */
.answer-jump {
  flex: none;
  padding: 0;
  border: 0;
  color: var(--color-accent);
  background: transparent;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.answer-jump:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
.answer-ok {
  color: #3d6b2f;
}
</style>
