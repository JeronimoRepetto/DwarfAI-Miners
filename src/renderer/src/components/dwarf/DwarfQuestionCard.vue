<script setup lang="ts">
import { computed } from 'vue'
import QuestionCard from '../message/QuestionCard.vue'
import {
  answerStatusLine,
  answerStateForAsk,
  freeTextRoute,
  isAnswerable,
  type AskAnswer
} from '../../lib/question/questionAnswer'
import {
  ANSWER_ONLY_WHERE_IT_RUNS,
  TYPED_HERE_REACHES_THE_PICKER,
  type DwarfAnswerState,
  type DwarfQuestion
} from '../../types'

/**
 * What an agent asked its user, and the answers it said it would take (#125), drawn as the
 * redesign's question card (#635, `organisms/question-card`, in QuestionCard.vue). Thin, like
 * every component here: this reads the ask off the wire and says what may be answered and where
 * typed words go; the card walks it, and lib/question decides what an answer carries.
 *
 * An ask on the terminal channel used to be drawn but not offered (#354). Since #362 it is
 * answered by keystroke at the console the session runs in, so what is left unanswerable is
 * narrower and still read off the wire rather than derived: more than one entry in `questions`
 * on that channel, because how the picker walks from one question to the next is unmeasured and
 * answering the first would move it somewhere nobody has watched (#443). Such a call can still be
 * WALKED — Back and Next stay live so every question can be read — but every option stays inert,
 * main's own sentence says where the answer goes, and the walk's Jump to terminal is the way
 * there. Both fields are exactly what main's `answerDwarfQuestion` guards on, so the card cannot
 * offer an answer main would refuse.
 *
 * A MULTI-SELECT ask is a toggle gesture on EITHER channel (#443 T3b): nothing is sent until
 * Submit is pressed. `@anthropic-ai/claude-agent-sdk` 0.3.258's own `sdk-tools.d.ts` documents
 * `AskUserQuestionOutput.answers` as "question text -> answer string; multi-select answers are
 * comma-separated" — see `togglesAt` in lib/question/questionAnswer.ts, the one place this is
 * decided.
 *
 * A call that asked several questions (#443) is walked one step at a time, and ONE Submit on the
 * last sends every answer in one request, enabled only once each has one: a picker handed some of
 * its answers is left waiting on the rest.
 *
 * One thing this component deliberately does NOT do: it never hides the question — the card is
 * drawn from the dwarf's own `pendingQuestion`, and only main's next snapshot may drop it, so a
 * panel that cleared it on send would be claiming the ask was closed on its own optimism.
 *
 * ## Where the words typed under "Other thing…" go
 *
 * Three answers, one per route, and `freeTextRoute` decides between them off the prompt's own
 * channel and the ask's own shape — in lib, because the permission card reads the same rule.
 *
 * - **Held** (#125): an ordinary MESSAGE, queued on the stream this panel owns, touching no
 *   picker. The card's Submit reads Send while they are picked, and the card stays (the decision
 *   log's Permission free text, which the ui-rebuild skill applies to "Other thing…" on held
 *   sessions alike).
 * - **Watched, one question, one answer** (#481): an ANSWER. Main reaches the row the session's
 *   own picker offers for exactly this — measured 2026-09-18, the digit one past the ask's
 *   options — types the words, and presses Enter once.
 * - **Watched, anything else**: refused. Free text there would leave on the message path, which
 *   on that channel writes into the session's own console — the picker reads the letters as its
 *   own input and the Enter behind them confirms whichever option is highlighted (#484). The row
 *   is drawn closed and TYPED_HERE_REACHES_THE_PICKER stands where its field would open, said
 *   before the key rather than after it. Gated on the two routes that MAY take words ('message',
 *   'answer') rather than on "not 'picker'" (F2, #588 T5), so a route freeTextRoute grows later
 *   fails shut.
 */

const props = withDefaults(
  defineProps<{
    question: DwarfQuestion
    /** The verdict of the last answer given for this dwarf, whatever ask it named. */
    answerState?: DwarfAnswerState
    /** The asker, for the card's name ("<name> is asking"). */
    name?: string
    /** The step the card opens on and the answers before it (the UI kit's Last step). */
    at?: number
    answers?: readonly string[]
  }>(),
  { answerState: undefined, name: 'The dwarf', at: 0, answers: () => [] }
)

const emit = defineEmits<{
  /**
   * Answer the ask with its own option labels: one value for a one-question call, one per
   * question in the call's order for a call that asked several (#443) — see AskAnswer.
   */
  answer: [answer: AskAnswer]
  /**
   * Answer the ask in the person's OWN words, through the "Other" row its picker offers (#481).
   * An ANSWER and not a message: it releases the same blocked tool call the options do.
   */
  'answer-text': [text: string]
  /** A free-form reply, which travels as a message rather than as an answer. */
  'send-text': [payload: { text: string; pressEnter: boolean }]
  /** Focus the console the session runs in, where an unanswerable ask waits. */
  'open-console': []
}>()

/** The verdict only where it belongs: a new ask never wears the last one's. */
const verdict = computed(() => answerStateForAsk(props.answerState, props.question.toolUseId))
/* An ask nothing here can answer, known before anybody clicks (#354, #362, #443). */
const unanswerable = computed(
  () => props.question.channel === 'terminal' && props.question.questions.length > 1
)
const answerable = computed(
  () => !unanswerable.value && isAnswerable(props.answerState, props.question.toolUseId)
)
const route = computed(() => freeTextRoute(props.question.channel, props.question))
const otherNote = computed(() =>
  route.value === 'message' || route.value === 'answer' ? null : TYPED_HERE_REACHES_THE_PICKER
)
/*
 * One row for both refusals, because they are the same sentence in the same place: main's,
 * verbatim. An unanswerable ask says it up front, a refused answer after the fact.
 */
const alert = computed(() => {
  if (unanswerable.value) return ANSWER_ONLY_WHERE_IT_RUNS
  return verdict.value?.phase === 'refused' ? verdict.value.error : null
})
const ok = computed(() => answerStatusLine(verdict.value))
/*
 * Jump to terminal is in the walk of every state the design draws, and it does what the header's
 * Open console does. Not on OpenCode's own permission channel (F2, #588 T5): no question reaches
 * it, but DwarfPromptChannel admits the value, and that channel has no console to jump to.
 */
const jump = computed(() => props.question.channel !== 'opencode-permission')

function submit(values: string[]): void {
  if (!answerable.value) return
  emit('answer', props.question.questions.length === 1 ? (values[0] ?? '') : values)
}
</script>

<template>
  <QuestionCard
    :name="name"
    :ask="question"
    :answerable="answerable"
    :route="route"
    :other-note="otherNote"
    :jump="jump"
    :alert="alert"
    :ok="ok"
    :at="at"
    :answers="answers"
    @submit="submit"
    @answer-text="emit('answer-text', $event)"
    @send-text="emit('send-text', { text: $event, pressEnter: true })"
    @jump="emit('open-console')"
  />
</template>
