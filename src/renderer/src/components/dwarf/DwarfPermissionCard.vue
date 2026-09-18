<script setup lang="ts">
import { computed, ref } from 'vue'
import { CONSOLE_HINT, JUMP_TO_TERMINAL_NAME } from '../../lib/delivery/actionBar'
import {
  PERMISSION_OPTIONS,
  PRESS_ENTER_TO_SEND,
  answerStateForAsk,
  canSendAnswer,
  decisionForLabel,
  freeTextRoute,
  isAnswerable,
  optionState,
  permissionStatusLine,
  selectOption,
  type QuestionSelection
} from '../../lib/question/questionAnswer'
import {
  MAX_DWARF_TEXT_CHARS,
  TYPED_HERE_REACHES_THE_PICKER,
  type DwarfAnswerState,
  type DwarfPermissionDecision,
  type DwarfPermissionRequest
} from '../../types'

/**
 * A tool call a held session is blocked on until the panel approves or
 * declines it (#203) — drawn with the design's question option card per the
 * maintainer's ruling on #203: "a permission is a question, and the panel
 * presents it as one".
 *
 * A SIBLING of DwarfQuestionCard rather than a reuse of it, for the same
 * reason DwarfPermissionRequest is a sibling of DwarfQuestion (see its own
 * doc comment): the two option labels drawn here are Claude Code's own, fixed
 * for every prompt, never the agent's words — so there is no `options` list
 * to iterate, only PERMISSION_OPTIONS. Select-then-Enter is unchanged from
 * the question card on purpose: a mis-click on Allow for a destructive
 * command must not fire on selection alone.
 *
 * Same two disciplines as DwarfQuestionCard. It never hides the prompt — the
 * card is drawn from the dwarf's own `pendingPermission`, and only main's next
 * snapshot may drop it once the held session moves past this tool call. And a
 * free-form reply still leaves on the ordinary message path rather than as a
 * decision: the channel here takes back only Allow or Deny, never a third
 * thing typed in.
 *
 * AMENDED for #481, exactly as the question card's twin of this paragraph was:
 * the message path is offered on the HELD channel only. A dialog at a terminal
 * is a y/n prompt drawn in the console the message path writes into, so the
 * letters are read by that dialog and the Enter behind them answers it — the
 * same failure the question picker has (#203's channel, #481's shape). Held
 * free text is queued on the stream this panel holds and reaches no dialog.
 *
 * The question card took a THIRD route at #481 item 3 and this one did not,
 * which is a difference in the prompts rather than in the cards. An
 * `AskUserQuestion` picker offers an "Other" row, and the keys that reach it
 * have been measured; a y/n dialog offers no such row at all, so there is
 * nothing here to type into and the refusal is the whole answer.
 */

const props = defineProps<{
  permission: DwarfPermissionRequest
  /** The verdict of the last decision given for this dwarf, whatever prompt it named. */
  answerState?: DwarfAnswerState
}>()

const emit = defineEmits<{
  /** Release the blocked tool call with one of Claude Code's own two answers. */
  decide: [decision: DwarfPermissionDecision]
  /** A free-form reply, which travels as a message rather than as a decision. */
  'send-text': [payload: { text: string; pressEnter: boolean }]
  /** Focus the console drawing this dialog, where a refused decision can still be given. */
  'open-console': []
}>()

const selection = ref<QuestionSelection | null>(null)
const freeform = ref('')

/** The verdict only where it belongs: a new prompt never wears the last one's. */
const verdict = computed(() => answerStateForAsk(props.answerState, props.permission.toolUseId))
const answerable = computed(() => isAnswerable(props.answerState, props.permission.toolUseId))
const canSend = computed(() =>
  canSendAnswer(selection.value, props.permission.toolUseId, props.answerState)
)
const selectedLabel = computed(() =>
  selection.value?.toolUseId === props.permission.toolUseId ? selection.value.label : null
)
const okLine = computed(() => permissionStatusLine(verdict.value, props.permission.channel))
/*
 * Where a refused decision leaves the person, and it is not here (#203). A
 * decision on the terminal channel is a keypress into a console this panel
 * does not own, so every way it fails — no window to focus, no measured key
 * for this build, a prompt that has since moved on — leaves the dialog
 * exactly where it was: open, at that terminal. The jump is the way there,
 * and it is the same control the #251 line offers for a prompt whose content
 * this panel could not read. A held prompt has no such second place, so it
 * gets no button.
 */
const showJump = computed(
  () => props.permission.channel === 'terminal' && verdict.value?.phase === 'refused'
)
/*
 * Whether the free-text box may be offered at all (#481) — the question card's
 * rule, read from lib so the two cards cannot come apart on it.
 */
// `null`, and that is the whole of this card's answer to #481 item 3: a y/n
// dialog has no "Other" row, so there is no third route for it to take.
const freeText = computed(() => freeTextRoute(props.permission.channel, null))
/*
 * ONE jump per card, never two: the refusal row below already carries it
 * wherever a refused decision is showing.
 */
const showPickerJump = computed(() => !showJump.value)

function cardClass(label: string): string {
  return `is-${optionState(selection.value, props.permission.toolUseId, label)}`
}

function choose(label: string): void {
  if (!answerable.value) return
  selection.value = selectOption(selection.value, props.permission.toolUseId, label)
}

function submit(): void {
  if (!canSend.value || selectedLabel.value === null) return
  const decision = decisionForLabel(selectedLabel.value)
  if (decision === null) return
  emit('decide', decision)
}

/**
 * Enter sends the selection, and must CONSUME the key: the chosen card still
 * has focus, and the click a browser synthesises from Enter on a focused
 * button is the gesture that deselects it — same reason DwarfQuestionCard's
 * own handler does this.
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
  <div class="permission-card" @keydown="onKeydown">
    <p class="permission-header">{{ permission.toolName }}</p>
    <p v-if="permission.title" class="permission-title">{{ permission.title }}</p>
    <pre class="permission-input">{{ permission.input }}</pre>
    <p v-if="permission.description" class="permission-description">
      {{ permission.description }}
    </p>

    <div class="options" role="group" aria-label="Allow or deny this tool call">
      <button
        v-for="option in PERMISSION_OPTIONS"
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
      question card has it: one surface, saying either "type instead" or
      "press Enter".
    -->
    <p v-if="selectedLabel !== null" class="enter-prompt" role="status">
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
      v-else-if="freeText === 'message'"
      v-model="freeform"
      class="freeform-input"
      rows="2"
      :maxlength="MAX_DWARF_TEXT_CHARS"
      placeholder="Write here..."
      aria-label="Tell this agent something instead of deciding"
      @keydown="onFreeformKeydown"
    ></textarea>
    <!--
      The box refused, in its own place, because the console it would be written
      into is drawing this dialog (#481) — the question card's own treatment,
      for the same reason it is said before the key rather than after it.
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

    <p v-if="verdict?.phase === 'refused'" class="answer-error" role="alert">
      <span>{{ verdict.error }}</span>
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
/*
 * Same card as DwarfQuestionCard's — same custom properties, same sizes — for
 * every part the two share. Nothing below invents a colour or a dimension the
 * question card does not already use.
 */
.permission-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 210px;
  text-align: left;
}
.permission-header {
  margin: 0;
  color: var(--color-accent);
  font-size: var(--text-meta);
  font-weight: 700;
}
/*
 * #347: the title and the description below are the agent SAYING what it wants
 * to do, so both take the conversation face and size. The header above stays
 * Tiny5 — that one is the tool's NAME, which is metadata.
 */
.permission-title {
  margin: 0;
  color: var(--color-cream);
  font-family: var(--font-conversation);
  font-size: var(--text-conversation);
  font-weight: 700;
  line-height: 1.3;
}
/*
 * The agent message surface from the design: cream, accent border, dark ink —
 * exactly DwarfQuestionCard's `.question-text`, plus the monospace treatment a
 * tool call's own redacted input needs to stay readable as code rather than
 * prose, and `break-all` so a long unbroken path or flag cannot force the
 * card wider than the question card ever gets.
 */
.permission-input {
  overflow-y: auto;
  overflow-x: hidden;
  margin: 0;
  max-height: 96px;
  padding: 5px 6px;
  border: 1px solid var(--color-accent);
  border-radius: 12px;
  color: var(--color-panel);
  background: var(--color-cream);
  /* #347 made this stack a token, so a bubble's code and this card share one. */
  font-family: var(--font-code);
  font-size: var(--text-meta);
  line-height: 1.35;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
  -webkit-user-select: text;
}
.permission-description {
  margin: 0;
  color: var(--color-cream);
  font-family: var(--font-conversation);
  font-size: var(--text-conversation);
  line-height: 1.3;
  opacity: 0.85;
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
/* What stands where the box was (#481) — DwarfQuestionCard's own rule, to the
   value: the refusal row's ink and size, because this is a refusal. */
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
/* The same underlined text button the MessagePanel's own approval line uses
   for the same act, so one affordance does not read as two. */
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
