<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  PRESS_ENTER_TO_SEND,
  answerStatusLine,
  answerStateForAsk,
  canSendAnswer,
  isAnswerable,
  optionState,
  selectOption,
  type QuestionSelection
} from '../../lib/question/questionAnswer'
import { MAX_DWARF_TEXT_CHARS, type DwarfAnswerState, type DwarfQuestion } from '../../types'

/**
 * What an agent asked its user, and the answers it said it would take (#125).
 *
 * Thin, like every component here: which card is selected, whether Enter would
 * send and what an answer carries are all decided in lib/question.
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
}>()

const selection = ref<QuestionSelection | null>(null)
const freeform = ref('')

/** The verdict only where it belongs: a new ask never wears the last one's. */
const verdict = computed(() => answerStateForAsk(props.answerState, props.question.toolUseId))
const answerable = computed(() => isAnswerable(props.answerState, props.question.toolUseId))
const canSend = computed(() =>
  canSendAnswer(selection.value, props.question.toolUseId, props.answerState)
)
const selectedLabel = computed(() =>
  selection.value?.toolUseId === props.question.toolUseId ? selection.value.label : null
)
const okLine = computed(() => answerStatusLine(verdict.value))

function cardClass(label: string): string {
  return `is-${optionState(selection.value, props.question.toolUseId, label)}`
}

function choose(label: string): void {
  if (!answerable.value) return
  selection.value = selectOption(selection.value, props.question.toolUseId, label)
}

function submit(): void {
  if (!canSend.value || selectedLabel.value === null) return
  emit('answer', selectedLabel.value)
}

/**
 * Enter sends the selection, and must CONSUME the key: the chosen card still
 * has focus, and the click a browser synthesises from Enter on a focused button
 * is the gesture that deselects it.
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
        :aria-pressed="selectedLabel === option.label ? 'true' : 'false'"
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
    -->
    <p v-if="selectedLabel !== null" class="enter-prompt" role="status">
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

    <p v-if="verdict?.phase === 'refused'" class="answer-error" role="alert">
      {{ verdict.error }}
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
/* The agent message surface from the design: cream, accent border, dark ink. */
.question-text {
  overflow-y: auto;
  margin: 0;
  max-height: 96px;
  padding: 5px 6px;
  border: 1px solid var(--color-accent);
  border-radius: 12px;
  color: var(--color-panel);
  background: var(--color-cream);
  font-size: var(--text-meta);
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
  font-size: var(--text-meta);
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
.answer-error,
.answer-ok {
  margin: 0;
  font-size: var(--text-helper);
  line-height: 1.25;
}
.answer-error {
  color: #8c2f14;
}
.answer-ok {
  color: #3d6b2f;
}
</style>
