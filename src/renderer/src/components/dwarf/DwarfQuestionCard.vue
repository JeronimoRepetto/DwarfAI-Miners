<script setup lang="ts">
import { computed, ref } from 'vue'
import { CONSOLE_HINT, JUMP_TO_TERMINAL_NAME } from '../../lib/delivery/actionBar'
import {
  NEXT_QUESTION_NAME,
  PRESS_ENTER_TO_SEND,
  PREVIOUS_QUESTION_NAME,
  SEND_ANSWER_NAME,
  SUBMIT_ANSWERS_NAME,
  answerStatusLine,
  answerStateForAsk,
  askAnswerValues,
  canSubmit,
  chooseAt,
  chosenAt,
  freeTextRoute,
  isAnswerable,
  optionStateAt,
  questionIndex,
  questionStepLine,
  stepQuestion,
  togglesAt,
  type AskAnswer,
  type AskAnswers,
  type QuestionCursor
} from '../../lib/question/questionAnswer'
import {
  ANSWER_ONLY_WHERE_IT_RUNS,
  MAX_DWARF_TEXT_CHARS,
  TYPED_HERE_REACHES_THE_PICKER,
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
 * rather than deriving it: more than one entry in `questions` on that channel,
 * because how the picker walks from one question to the next is unmeasured and
 * answering the first would move it somewhere nobody has watched (#443). Such
 * a call can still be WALKED — Back and Next stay live so every question can be
 * read — but the header, the question and every option of each
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
 * ## A call that asked several questions (#443)
 *
 * The card shows question k of n, with Back and Next between them, and ONE
 * Submit on the last question that sends every answer in one request — enabled
 * only once each question has one, because a picker handed some of its answers
 * is left waiting on the rest. What is chosen is kept per ask AND per question
 * (see AskAnswers), so a choice never lands on a question nobody has read. Each
 * question keeps the gesture the one-question card would give it, read per
 * question by `togglesAt`. Enter sends nothing on such a call: the Submit is its
 * only send, exactly as the Answer control is a toggling ask's. A one-question
 * call draws none of this and behaves as it always has.
 *
 * One thing this component deliberately does NOT do: it never hides the
 * question — the card is drawn from the dwarf's own `pendingQuestion`, and only
 * main's next snapshot may drop it, so a panel that cleared it on send would be
 * claiming the ask was closed on the strength of its own optimism.
 *
 * ## Where the "Other Thing" box sends what is typed into it
 *
 * Three answers, one per route, and `freeTextRoute` decides between them off
 * the prompt's own channel and the ask's own shape — in lib, because the
 * permission card reads the same rule and two templates would drift.
 *
 * - **Held** (#125, unchanged): the words leave on the ordinary MESSAGE path.
 *   They are queued on the stream this panel owns and touch no picker.
 * - **Watched, one question, one answer** (#481): the words leave as an
 *   ANSWER. Main reaches the row the session's own picker offers for exactly
 *   this — measured 2026-09-18, the digit one past the ask's options — types
 *   them, and presses Enter once. The card used to say the answer channel takes
 *   back only the agent's own words; the agent's own picker offers this row, so
 *   that is still true of what this app invents, which is nothing.
 * - **Watched, anything else**: refused, with TYPED_HERE_REACHES_THE_PICKER in
 *   the box's place. Free text there would leave on the message path, which on
 *   that channel writes into the session's own console — the picker reads the
 *   letters as its own input and the Enter behind them confirms whichever
 *   option is highlighted (#484, the stop-gap this replaced for the one shape
 *   that has since been measured).
 */

const props = defineProps<{
  question: DwarfQuestion
  /** The verdict of the last answer given for this dwarf, whatever ask it named. */
  answerState?: DwarfAnswerState
}>()

const emit = defineEmits<{
  /**
   * Answer the ask with its own option labels: one value for a one-question
   * call, one per question in the call's order for a call that asked several
   * (#443) — see AskAnswer.
   */
  answer: [answer: AskAnswer]
  /**
   * Answer the ask in the person's OWN words, through the "Other" row its
   * picker offers (#481). An ANSWER and not a message: main types it into that
   * row and presses Enter once, so it releases the same blocked tool call the
   * options do. Emitted only where that row has a measured route to it — see
   * freeTextRoute.
   */
  'answer-text': [text: string]
  /** A free-form reply, which travels as a message rather than as an answer. */
  'send-text': [payload: { text: string; pressEnter: boolean }]
  /** Focus the console the session runs in, where an unanswerable ask waits. */
  'open-console': []
}>()

/*
 * One record of choices for every question of the ask, and which question is
 * showing — both keyed by the ask's id in lib, so neither outlives the ask it
 * was made for (#443).
 */
const answers = ref<AskAnswers | null>(null)
const cursor = ref<QuestionCursor | null>(null)
const freeform = ref('')

/** The verdict only where it belongs: a new ask never wears the last one's. */
const verdict = computed(() => answerStateForAsk(props.answerState, props.question.toolUseId))
/*
 * An ask nothing here can answer, known before anybody clicks (#354, #362).
 * Off the wire rather than off the dwarf, because the wire is where main put
 * the two readings its own guard uses — see DwarfPromptChannel and
 * DwarfQuestion.questions.
 */
const unanswerable = computed(
  () => props.question.channel === 'terminal' && props.question.questions.length > 1
)
/** Whether this call asked several questions, and so is walked rather than shown whole (#443). */
const walking = computed(() => props.question.questions.length > 1)
const index = computed(() => questionIndex(cursor.value, props.question))
const onLast = computed(() => index.value === props.question.questions.length - 1)
const stepLine = computed(() => questionStepLine(index.value, props.question.questions.length))
/*
 * The question this card draws: the one the walk is on (#443). Never undefined
 * on the wire — a writer with nothing to carry puts no ask there — so the
 * fallback is only the type system's.
 */
const shown = computed(
  () => props.question.questions[index.value] ?? { question: '', multiSelect: false, options: [] }
)
/*
 * Whether the shown question's options are toggles rather than one choice
 * (#362). The channel, not just `multiSelect`: only the terminal gesture for
 * several answers has been measured — see the module comment and togglesAt.
 */
const toggling = computed(() => togglesAt(props.question, index.value))
const answerable = computed(
  () => !unanswerable.value && isAnswerable(props.answerState, props.question.toolUseId)
)
const chosen = computed(() => chosenAt(answers.value, props.question.toolUseId, index.value))
const selectedLabel = computed(() => (toggling.value ? null : (chosen.value[0] ?? null)))
/** Whether Enter would send: a one-question, single-choice ask with something chosen. */
const canSend = computed(
  () => !walking.value && !toggling.value && selectedLabel.value !== null && answerable.value
)
/** Whether the Answer control is there to press, which is the toggling ask's own send. */
const canAnswerToggles = computed(
  () => !walking.value && toggling.value && chosen.value.length > 0 && answerable.value
)
/*
 * The walked call's one send (#443): drawn on the last question of an ask this
 * panel can answer, and pressable only once every question has an answer.
 */
const showSubmit = computed(() => walking.value && onLast.value && !unanswerable.value)
const canSubmitAll = computed(() => answerable.value && canSubmit(answers.value, props.question))
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
/*
 * Whether the free-text box may be offered at all (#481), decided in lib rather
 * than as a `channel ===` here so both cards read one rule.
 */
const freeText = computed(() => freeTextRoute(props.question.channel, props.question))
/*
 * The refused box's own way to the terminal — and ONE jump per card, never two.
 * The refusal row below already carries it wherever a refusal is showing, and
 * two buttons doing one act would read as two different acts.
 */
const showPickerJump = computed(() => !showJump.value)

function cardClass(label: string): string {
  return `is-${optionStateAt(answers.value, props.question, index.value, label)}`
}

function isChosen(label: string): boolean {
  return chosen.value.includes(label)
}

function choose(label: string): void {
  if (!answerable.value) return
  answers.value = chooseAt(answers.value, props.question, index.value, label)
}

/*
 * Back and Next stay live on a call nothing here can answer: reading every
 * question is what the person needs before they go to the terminal (#443).
 */
function step(delta: number): void {
  cursor.value = stepQuestion(cursor.value, props.question, delta)
}

function submit(): void {
  if (!canSend.value || selectedLabel.value === null) return
  emit('answer', selectedLabel.value)
}

/** The toggling ask's send: every toggled label, in the ask's own option order. */
function answerToggles(): void {
  if (!canAnswerToggles.value) return
  const answer = askAnswerValues(answers.value, props.question)?.[0]
  if (answer === undefined) return
  emit('answer', answer)
}

/** The walked call's send: one value per question, in one request (#443). */
function submitAll(): void {
  if (!showSubmit.value || !canSubmitAll.value) return
  const values = askAnswerValues(answers.value, props.question)
  if (values === null) return
  emit('answer', values)
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

/**
 * The convention every composer here uses: Enter sends, Shift+Enter writes a
 * newline.
 *
 * Where those words GO is `freeText`'s to decide and not this handler's (#481).
 * On a held session they leave as a message, exactly as they have since #125.
 * On a watched one whose picker has a measured "Other" row they leave as an
 * ANSWER — so the in-flight guard applies to them: a typed answer behind an
 * option answer would release the same blocked tool call twice, and this box is
 * the one control on the card that is not a button something else disabled.
 */
function onFreeformKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  const text = freeform.value.trim()
  if (text === '') return
  if (freeText.value === 'answer') {
    if (!answerable.value) return
    emit('answer-text', text)
  } else {
    emit('send-text', { text, pressEnter: true })
  }
  freeform.value = ''
}
</script>

<template>
  <div class="question-card" @keydown="onKeydown">
    <!--
      The walk through a several-question call (#443), above the question it
      moves, and absent for a one-question call so that card is unchanged.
      Built from controls the card already draws: the step line is the Other
      Thing label's type, and Back / Next are the jump's text buttons.
    -->
    <div v-if="walking" class="question-walk" role="group" aria-label="Questions in this ask">
      <button class="question-back" type="button" :disabled="index === 0" @click="step(-1)">
        {{ PREVIOUS_QUESTION_NAME }}
      </button>
      <p class="question-step" role="status">{{ stepLine }}</p>
      <button class="question-next" type="button" :disabled="onLast" @click="step(1)">
        {{ NEXT_QUESTION_NAME }}
      </button>
    </div>
    <p v-if="shown.header" class="question-header">{{ shown.header }}</p>
    <p class="question-text">{{ shown.question }}</p>

    <div class="options" role="group" aria-label="Answers this agent offered">
      <button
        v-for="option in shown.options"
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

      A walked call's Submit takes that same surface on its last question, and
      is drawn there disabled until every question has an answer, so the person
      can see what is still missing is the reason it does not send (#443).
    -->
    <button
      v-if="showSubmit"
      class="answer-send answer-submit"
      type="button"
      :disabled="!canSubmitAll"
      @click="submitAll()"
    >
      {{ SUBMIT_ANSWERS_NAME }}
    </button>
    <button v-else-if="canAnswerToggles" class="answer-send" type="button" @click="answerToggles()">
      {{ SEND_ANSWER_NAME }}
    </button>
    <p
      v-else-if="!walking && !toggling && selectedLabel !== null"
      class="enter-prompt"
      role="status"
    >
      {{ PRESS_ENTER_TO_SEND }}
    </p>
    <!--
      The one maxlength #431 left standing, stated here rather than inherited.
      This box is not a message: it is a line of the person’s own words
      answering a prompt the agent itself raised, and it travels the ANSWER
      path — released through the SDK on a held session, typed as the
      picker’s own keys on a terminal one. The card is handed the prompt and
      not the dwarf, so it cannot read the per-route ceiling the composer
      does; the wire ceiling is the widest bound certainly true of both
      routes, and a cut at fifteen thousand characters of a one-line answer is
      a case nobody meets. Give the card a dwarf and this becomes the
      composer’s treatment.
    -->
    <textarea
      v-else-if="freeText !== 'picker'"
      v-model="freeform"
      class="freeform-input"
      rows="2"
      :maxlength="MAX_DWARF_TEXT_CHARS"
      placeholder="Write here..."
      aria-label="Answer this agent in your own words"
      @keydown="onFreeformKeydown"
    ></textarea>
    <!--
      The box refused, in its own place, because the console it would be written
      into is drawing a picker this app has no measured way into (#481). Said
      here rather than left to the alert row below: a person who learns this
      AFTER pressing Enter has already had an option confirmed in their name.
    -->
    <p v-else class="freeform-refused" role="note">
      <span>{{ TYPED_HERE_REACHES_THE_PICKER }}</span>
      <button
        v-if="showPickerJump"
        class="answer-jump"
        type="button"
        :title="CONSOLE_HINT"
        @click="emit('open-console')"
      >
        {{ JUMP_TO_TERMINAL_NAME }}
      </button>
    </p>

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
/* What stands where the box was (#481). The refusal row's own ink and size
   rather than the box's surface: this is a refusal, not a prompt, and it
   carries the same jump that row does. */
.freeform-refused {
  display: flex;
  gap: 6px;
  align-items: baseline;
  margin: 0;
  color: #8c2f14;
  font-size: var(--text-helper);
  line-height: 1.25;
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
/*
 * A walked call's Submit before every question has an answer (#443). The
 * design's disabled-control convention applies here (foundations.md): the
 * foreground shows "do-not-click" in --color-control-disabled (3.61:1),
 * against --color-panel-deep. The dimmed option pair is a different state —
 * passed over but still clickable — so it does not apply to disabled controls.
 */
.answer-send:disabled {
  border: 2px solid var(--color-control-disabled);
  color: var(--color-control-disabled);
  cursor: not-allowed;
  background: var(--color-panel-deep);
}
/* The walk's row (#443): Back, the k-of-n line, Next, on one baseline. */
.question-walk {
  display: flex;
  gap: 6px;
  align-items: baseline;
  justify-content: space-between;
}
/* The Other Thing label's own values: chrome around the agent's words, not them. */
.question-step {
  margin: 0;
  color: var(--color-cream);
  font-size: var(--text-meta);
  font-weight: 700;
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
   button the MessagePanel's own approval line uses for the same act. Back and
   Next take it too (#443): a text button that moves the card, not a send. */
.answer-jump,
.question-back,
.question-next {
  flex: none;
  padding: 0;
  border: 0;
  color: var(--color-accent);
  background: transparent;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.answer-jump:focus-visible,
.question-back:focus-visible,
.question-next:focus-visible {
  outline: 2px solid var(--color-cream);
  outline-offset: 2px;
}
/* Nowhere further to go: the underline that says "press me" goes, and the
   text takes the disabled-control colour (foundations.md, --color-control-disabled)
   to show it cannot be chosen. */
.question-back:disabled,
.question-next:disabled {
  color: var(--color-control-disabled);
  text-decoration: none;
  cursor: not-allowed;
}
.answer-ok {
  color: #3d6b2f;
}
</style>
