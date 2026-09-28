<script setup lang="ts">
/*
 * The question card (#635), `organisms/question-card` in the design: a dwarf asking, in place of
 * the composer. One card for a question and for a permission, which is "the same card with one
 * step" (components.md, Question card; decision log, Permission card). Its host decides what the
 * ask is and what may be answered; this walks it.
 *
 * - The head: the "? asks" pill ("! asks" on a permission), the question in the Messages role in
 *   bold — a permission's request in the chat bubble's code block instead — and the step count.
 * - The body: the step's options as 40px rows with their number keys, and "Other thing…" last,
 *   which opens the free-answer field under them.
 * - The walk: Back, the step dots, Jump to terminal, then Next, or Submit on the last step.
 *
 * Picking never sends: Submit is the one send, and Enter moves on a step at most. On a
 * question, the words under "Other thing…" are that step's free answer: the step counts as
 * answered while the field holds text, and Submit sends them by the route the host names —
 * typed at a watched picker's own Other row (`route` 'answer'), or, on a held session, the
 * message path the app has always used, since main's held path releases an ask with its own
 * labels only (`route` 'message'). On a PERMISSION they are never a decision: Submit reads Send
 * while they are picked, hands them up as a message, clears the field and leaves the card in
 * place (decision log, Permission free text).
 *
 * Which of those words the design leaves to the app, and how this card reads them:
 * - Next wakes once the step is answered, as designed, except on an ask nothing here may answer,
 *   which walks freely so every question can be read before the person goes to the terminal
 *   (#443).
 * - A held ask of several questions with a step answered in words cannot be released: the held
 *   path takes labels only, and no one message carries a walk's answers today. Submit stays
 *   asleep until every step holds a label (named in #635's PR, a question for the design lead).
 */
import { computed, nextTick, ref, watch } from 'vue'
import ActionButton from '../controls/ActionButton.vue'
import InputField from '../controls/InputField.vue'
import StatePill from '../dwarf/StatePill.vue'
import QuestionOption from './QuestionOption.vue'
import { belongsToComposition } from '../../lib/controls/input'
import { CONSOLE_HINT, JUMP_TO_TERMINAL_NAME } from '../../lib/delivery/actionBar'
import {
  NEXT_QUESTION_NAME,
  PREVIOUS_QUESTION_NAME,
  SUBMIT_ANSWERS_NAME,
  askAnswerValues,
  canSubmit,
  chooseAt,
  chosenAt,
  questionIndex,
  questionStepLine,
  togglesAt,
  type AskAnswers,
  type AskShape,
  type FreeTextRoute,
  type QuestionCursor
} from '../../lib/question/questionAnswer'
import {
  OTHER_FIELD_NAME,
  OTHER_PLACEHOLDER,
  OTHER_THING_LABEL,
  REQUEST_REGION_NAME,
  SEND_OTHER_NAME,
  askMark,
  askingName,
  clearChosenAt,
  digitPick,
  dropOtherAt,
  otherAt,
  pickOtherAt,
  stepAnswered,
  stepDots,
  writeOtherAt,
  type OtherTexts
} from '../../lib/question/questionCard'
import { MAX_DWARF_TEXT_CHARS } from '../../types'

const props = withDefaults(
  defineProps<{
    /** The asker, for the card's name ("<name> is asking"). */
    name: string
    ask: AskShape
    /** The permission card: "! asks", and the step text is the request, in the code block. */
    permission?: boolean
    /** Whether the options may be picked and Submit may send, off the host's own guard. */
    answerable: boolean
    /** Where the words under "Other thing…" go (freeTextRoute); 'picker' and 'closed' refuse. */
    route: FreeTextRoute
    /** Why "Other thing…" is closed, said where its field would open. */
    otherNote?: string | null
    /** Whether Jump to terminal is drawn: there is a console to jump to. */
    jump?: boolean
    /** Main's refusal, verbatim. */
    alert?: string | null
    /** What may honestly be said about a released answer. */
    ok?: string | null
    /** The step the card opens on, and the answers the steps before it hold (the UI kit's). */
    at?: number
    answers?: readonly string[]
  }>(),
  {
    permission: false,
    otherNote: null,
    jump: true,
    alert: null,
    ok: null,
    at: 0,
    answers: () => []
  }
)

const emit = defineEmits<{
  /** One answer value per step, in the ask's order (askAnswerValues). */
  submit: [values: string[]]
  /** The words under "Other thing…" as the ANSWER, where the route takes them as one. */
  'answer-text': [text: string]
  /** The words under "Other thing…" as an ordinary message. */
  'send-text': [text: string]
  jump: []
}>()

const root = ref<HTMLElement | null>(null)

function opening(): { chosen: AskAnswers | null; cursor: QuestionCursor } {
  let chosen: AskAnswers | null = null
  for (const [index, label] of props.answers.entries()) {
    chosen = chooseAt(chosen, props.ask, index, label)
  }
  return { chosen, cursor: { toolUseId: props.ask.toolUseId, index: props.at } }
}

const opened = opening()
const picked = ref<AskAnswers | null>(opened.chosen)
const cursor = ref<QuestionCursor | null>(opened.cursor)
const other = ref<OtherTexts | null>(null)

const id = computed(() => props.ask.toolUseId)
const count = computed(() => props.ask.questions.length)
const index = computed(() => questionIndex(cursor.value, props.ask))
const step = computed(
  () => props.ask.questions[index.value] ?? { question: '', multiSelect: false, options: [] }
)
const onLast = computed(() => index.value >= count.value - 1)
const toggling = computed(() => togglesAt(props.ask, index.value))
const chosen = computed(() => chosenAt(picked.value, id.value, index.value))
const otherText = computed(() => otherAt(other.value, id.value, index.value))
const otherOffered = computed(
  () => props.route === 'message' || (props.route === 'answer' && props.answerable)
)
const otherOpen = computed(() => otherText.value !== null && otherOffered.value)
/** A permission's words under "Other thing…" are a message, and picked: Submit reads Send. */
const sendsMessage = computed(
  () => props.permission && props.route === 'message' && otherText.value !== null
)
const answered = computed(() => stepAnswered(props.ask, index.value, picked.value, other.value))
const nextEnabled = computed(() => answered.value || !props.answerable)
const showNext = computed(() => !onLast.value && !sendsMessage.value)
const showSubmit = computed(() => onLast.value || sendsMessage.value)
const primaryLabel = computed(() => (sendsMessage.value ? SEND_OTHER_NAME : SUBMIT_ANSWERS_NAME))
/** Where the route takes the words as the answer, the one step they answer. */
const typedAnswer = computed(() => {
  if (props.route !== 'answer' || !props.answerable) return null
  const text = (otherAt(other.value, id.value, 0) ?? '').trim()
  return text === '' ? null : text
})
/** A held question's one step answered in words, which leave on the message path. */
const typedMessage = computed(() => {
  if (props.permission || props.route !== 'message' || count.value !== 1) return null
  const text = (otherAt(other.value, id.value, 0) ?? '').trim()
  return text === '' ? null : text
})
const submitEnabled = computed(() => {
  if (sendsMessage.value) return (otherText.value ?? '').trim() !== ''
  if (!props.answerable) return false
  return (
    typedAnswer.value !== null || typedMessage.value !== null || canSubmit(picked.value, props.ask)
  )
})
const dots = computed(() => stepDots(props.ask, index.value, picked.value, other.value))

// A new ask opens on its first step with nothing picked: the state is keyed by the ask's id.
watch(id, () => {
  cursor.value = null
})

function rows(): HTMLElement[] {
  return [...(root.value?.querySelectorAll<HTMLElement>('.dm-qopt') ?? [])]
}

async function focusRow(k: number): Promise<void> {
  await nextTick()
  rows()[k]?.focus({ preventScroll: true })
}

async function focusField(): Promise<void> {
  await nextTick()
  root.value?.querySelector<HTMLInputElement>('.dm-qopt-other-field input')?.focus()
}

/** Pick option `k` of the shown step, "Other thing…" one past the last. A key never unpicks. */
function pick(k: number, byKey = false): void {
  if (k === step.value.options.length) {
    if (!otherOffered.value) return
    picked.value = clearChosenAt(picked.value, id.value, index.value)
    other.value = pickOtherAt(other.value, id.value, index.value)
    void focusField()
    return
  }
  const label = step.value.options[k]?.label
  if (label === undefined || !props.answerable) return
  const already = chosen.value.includes(label)
  if (!(byKey && already && !toggling.value)) {
    picked.value = chooseAt(picked.value, props.ask, index.value, label)
  }
  other.value = dropOtherAt(other.value, id.value, index.value)
  void focusRow(k)
}

function write(text: string): void {
  other.value = writeOtherAt(other.value, id.value, index.value, text)
}

async function go(n: number): Promise<void> {
  if (n < 0 || n >= count.value) return
  cursor.value = { toolUseId: id.value, index: n }
  await nextTick()
  const shown = rows()
  const target = shown.find((row) => row.getAttribute('aria-checked') === 'true') ?? shown[0]
  target?.focus({ preventScroll: true })
}

function onSubmit(): void {
  if (!submitEnabled.value) return
  if (sendsMessage.value) {
    const text = (otherText.value ?? '').trim()
    other.value = dropOtherAt(other.value, id.value, index.value)
    emit('send-text', text)
    void focusRow(0)
    return
  }
  if (typedAnswer.value !== null && otherAt(other.value, id.value, 0) !== null) {
    emit('answer-text', typedAnswer.value)
    return
  }
  if (typedMessage.value !== null && otherAt(other.value, id.value, 0) !== null) {
    const text = typedMessage.value
    other.value = dropOtherAt(other.value, id.value, 0)
    emit('send-text', text)
    void focusRow(0)
    return
  }
  const values = askAnswerValues(picked.value, props.ask)
  if (values !== null) emit('submit', values)
}

/**
 * The card's keys (accessibility.md, Keyboard): a digit picks the option with that number,
 * "Other thing…" included, and never while typing in the field; Enter on an answered row, or in
 * the field once it holds text, moves to the next step and never re-picks the row; on the last
 * step it does nothing. An Enter an input method uses to pick its candidate is not one (#635).
 */
function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement
  if (target.tagName === 'INPUT') {
    if (event.key !== 'Enter' || belongsToComposition(event)) return
    event.preventDefault()
    if (answered.value && !onLast.value) void go(index.value + 1)
    return
  }
  const k = digitPick(event, step.value.options.length, otherOffered.value)
  if (k !== null) {
    if (k < step.value.options.length && !props.answerable) return
    event.preventDefault()
    pick(k, true)
    return
  }
  if (event.key === 'Enter' && target.classList.contains('dm-qopt') && answered.value) {
    event.preventDefault()
    if (!onLast.value) void go(index.value + 1)
  }
}

function dotClass(dot: string): string | undefined {
  return dot === 'open' ? undefined : `is-${dot}`
}
</script>

<template>
  <section ref="root" class="dm-qcard" :aria-label="askingName(name)" @keydown="onKeydown">
    <!-- The agent's own short title for the step, when it wrote one (#125); the design has none. -->
    <p v-if="step.header" class="dm-qcard__header">{{ step.header }}</p>
    <div class="dm-qcard__head">
      <StatePill text="asks" tone="needs" ask :mark="askMark(permission)" />
      <pre v-if="permission" class="dm-qcard__req" tabindex="0" :aria-label="REQUEST_REGION_NAME">{{
        step.question
      }}</pre>
      <p v-else class="dm-qcard__q">{{ step.question }}</p>
      <StatePill class="dm-qcard__step" :text="questionStepLine(index, count)" />
    </div>
    <div :key="`${id}:${index}`" class="dm-qcard__body">
      <div
        class="dm-qcard__opts"
        :role="toggling ? 'group' : 'radiogroup'"
        :aria-label="step.question"
      >
        <QuestionOption
          v-for="(option, k) in step.options"
          :key="option.label"
          :label="option.label"
          :index="k"
          :description="option.description"
          :checked="chosen.includes(option.label)"
          :toggle="toggling"
          :disabled="!answerable"
          @click="pick(k)"
        />
        <QuestionOption
          :label="OTHER_THING_LABEL"
          :index="step.options.length"
          other
          :checked="otherText !== null"
          :disabled="!otherOffered"
          @click="pick(step.options.length)"
        />
      </div>
      <InputField
        v-if="otherOpen"
        class="dm-qopt-other-field"
        :placeholder="OTHER_PLACEHOLDER"
        :label="OTHER_FIELD_NAME"
        :value="otherText ?? ''"
        :max-length="MAX_DWARF_TEXT_CHARS"
        @update:value="write"
      />
      <p v-if="otherNote" class="dm-qcard__closed" role="note">{{ otherNote }}</p>
    </div>
    <div class="dm-qcard__walk">
      <ActionButton
        class="dm-qcard__back"
        :label="PREVIOUS_QUESTION_NAME"
        :disabled="index === 0"
        @click="go(index - 1)"
      />
      <span class="dm-qcard__dots" aria-hidden="true">
        <i v-for="(dot, k) in dots" :key="k" :class="dotClass(dot)"></i>
      </span>
      <span class="dm-qcard__spacer"></span>
      <ActionButton
        v-if="jump"
        class="dm-qcard__jump"
        variant="link"
        :label="JUMP_TO_TERMINAL_NAME"
        :title="CONSOLE_HINT"
        @click="emit('jump')"
      />
      <ActionButton
        v-if="showNext"
        class="dm-qcard__next"
        :label="NEXT_QUESTION_NAME"
        :disabled="!nextEnabled"
        @click="go(index + 1)"
      />
      <ActionButton
        v-if="showSubmit"
        class="dm-qcard__submit"
        variant="primary"
        :label="primaryLabel"
        :disabled="!submitEnabled"
        @click="onSubmit"
      />
    </div>
    <p v-if="alert" class="dm-qcard__alert" role="alert">{{ alert }}</p>
    <p v-else-if="ok" class="dm-qcard__ok" role="status">{{ ok }}</p>
  </section>
</template>

<style scoped>
/* The design's question-card.css, rule for rule and in its order. */
.dm-qcard {
  display: grid;
  gap: 4px;
  padding: 8px;
}
.dm-qcard__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 2px 4px;
}
.dm-qcard__q {
  flex: 1;
  font: 700 var(--fs-body) / 1.35 var(--f-talk);
  color: var(--parchment);
  user-select: text;
}
/*
 * A permission's request: the chat bubble's code block (ChatBubble.vue, `.dm-bubble pre`),
 * declaration for declaration, then only what the card adds — the ink it sits in, wrapping in
 * place of sideways scroll, and the six-line cap (decision log, Permission request).
 */
.dm-qcard__req {
  margin: 0;
  padding: 6px 8px;
  font: var(--fs-meta) / 1.4 var(--f-code);
  background: var(--parch-lo);
  box-shadow: inset 2px 2px 0 0 var(--gold-lo);
  flex: 1;
  min-width: 0;
  max-height: calc(6lh + 12px);
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink-on-light);
  user-select: text;
}
.dm-qcard__step {
  flex: none;
}
.dm-qcard__opts {
  display: grid;
  gap: 0;
}
.dm-qcard__walk {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-top: 4px;
}
.dm-qcard__walk .dm-qcard__spacer {
  flex: 1;
}
/* In a narrow pane Jump to terminal breaks onto two lines before anything overflows. */
.dm-qcard__walk .dm-qcard__jump :deep(.dm-btn__label) {
  white-space: normal;
  text-align: center;
}
.dm-qcard__dots {
  display: flex;
  gap: 4px;
  margin: 0 6px;
}
.dm-qcard__dots i {
  width: 6px;
  height: 6px;
  background: var(--rock-lo);
  box-shadow: 0 0 0 2px var(--wood-lo);
}
.dm-qcard__dots i.is-done {
  background: var(--gold);
}
.dm-qcard__dots i.is-here {
  background: var(--brass-hi);
}
.dm-qcard__body {
  animation: dm-fade-in var(--dur-base) var(--ease-out) both;
}
.dm-qopt-other-field {
  margin: 2px 2px 4px 24px;
}
/*
 * What the design does not draw and the app keeps (#635, named in its PR): the agent's own step
 * title, why "Other thing…" is closed, and main's verdict. Small text, the design's role for a
 * line that is not the dwarf talking; the verdicts in the status inks.
 */
.dm-qcard__header,
.dm-qcard__closed,
.dm-qcard__alert,
.dm-qcard__ok {
  padding: 0 2px;
  font: var(--fs-meta) / 1.3 var(--f-meta);
  color: var(--ink-soft);
}
.dm-qcard__alert {
  color: var(--danger-hi);
}
.dm-qcard__ok {
  color: var(--ok);
}
@keyframes dm-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
