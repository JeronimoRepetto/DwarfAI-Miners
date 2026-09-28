<script setup lang="ts">
import { computed } from 'vue'
import QuestionCard from '../message/QuestionCard.vue'
import {
  answerStateForAsk,
  decisionForLabel,
  freeTextRoute,
  isAnswerable,
  permissionStatusLine,
  type OwnWordsAnswer
} from '../../lib/question/questionAnswer'
import { permissionAsk } from '../../lib/question/questionCard'
import {
  OPENCODE_PERMISSION_ANSWERED_ABOVE,
  TYPED_HERE_REACHES_THE_PICKER,
  type DwarfAnswerState,
  type DwarfPermissionDecision,
  type DwarfPermissionRequest
} from '../../types'

/**
 * A tool call a session is blocked on until the panel approves or declines it (#203), drawn as
 * the redesign's question card with one step (#635; decision log, Permission card): "! asks", the
 * request in the chat bubble's code block, Allow then Deny, and "Other thing…".
 *
 * Still not a DwarfQuestion, for the reason DwarfPermissionRequest is a sibling of it: the two
 * labels are Claude Code's own, fixed for every prompt, never the agent's words. So the card is
 * handed the permission's own one-step shape (permissionAsk), never a question built from it.
 * Select-then-Submit on purpose: a mis-click on Allow for a destructive command must not fire on
 * selection alone.
 *
 * It never hides the prompt — the card is drawn from the dwarf's own `pendingPermission`, and
 * only main's next snapshot may drop it once the session moves past this tool call. And the
 * words typed under "Other thing…" are never a decision: the channel takes back only Allow or
 * Deny (decision log, Permission free text). On the HELD channel they are an ordinary message —
 * Submit reads Send, and the card stays until a decision is submitted. A dialog at a terminal is
 * a y/n prompt drawn in the console the message path writes into, so there the row is closed
 * (#481), and OpenCode's own dialog closes it for the race docs/opencode-format.md Row 13
 * measured (#588 T5), in OpenCode's own words.
 */

const props = withDefaults(
  defineProps<{
    permission: DwarfPermissionRequest
    /** The verdict of the last decision given for this dwarf, whatever prompt it named. */
    answerState?: DwarfAnswerState
    /** The asker, for the card's name ("<name> is asking"). */
    name?: string
  }>(),
  { answerState: undefined, name: 'The dwarf' }
)

const emit = defineEmits<{
  /** Release the blocked tool call with one of Claude Code's own two answers. */
  decide: [decision: DwarfPermissionDecision]
  /** A free-form reply, which travels as a message rather than as a decision. */
  'send-text': [payload: { text: string; pressEnter: boolean }]
  /** Focus the console drawing this dialog, where a refused decision can still be given. */
  'open-console': []
}>()

const ask = computed(() => permissionAsk(props.permission))
/** The verdict only where it belongs: a new prompt never wears the last one's. */
const verdict = computed(() => answerStateForAsk(props.answerState, props.permission.toolUseId))
const answerable = computed(() => isAnswerable(props.answerState, props.permission.toolUseId))
// `null`: a y/n dialog has no "Other" row, so there is no third route for it to take (#481).
const route = computed(() => freeTextRoute(props.permission.channel, null))
const otherNote = computed(() => {
  if (route.value === 'message') return null
  return route.value === 'closed'
    ? OPENCODE_PERMISSION_ANSWERED_ABOVE
    : TYPED_HERE_REACHES_THE_PICKER
})
const alert = computed(() => (verdict.value?.phase === 'refused' ? verdict.value.error : null))
const ok = computed(() => permissionStatusLine(verdict.value, props.permission.channel))
/*
 * Jump to terminal is in the walk of every state the design draws, the Permission state
 * included, and does what the header's Open console does. Never on OpenCode's own channel: there
 * is no console that dialog is drawn in (review finding F2, #588 T5).
 */
const jump = computed(() => props.permission.channel !== 'opencode-permission')

function submit(values: (string | OwnWordsAnswer)[]): void {
  // A permission's only answers are its two labels: words never reach here (they are a message).
  const first = values[0]
  const decision = typeof first === 'string' ? decisionForLabel(first) : null
  if (decision === null || !answerable.value) return
  emit('decide', decision)
}
</script>

<template>
  <QuestionCard
    :name="name"
    :ask="ask"
    permission
    :answerable="answerable"
    :route="route"
    :other-note="otherNote"
    :jump="jump"
    :alert="alert"
    :ok="ok"
    @submit="submit"
    @send-text="emit('send-text', { text: $event, pressEnter: true })"
    @jump="emit('open-console')"
  />
</template>
