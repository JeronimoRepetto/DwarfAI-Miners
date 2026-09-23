import {
  askHasAReachableOtherRow,
  joinAnswerLabels,
  type DwarfAnswerState,
  type DwarfPermissionAnswerRequest,
  type DwarfPermissionDecision,
  type DwarfPermissionRequest,
  type DwarfPromptChannel,
  type DwarfQuestion,
  type DwarfQuestionLabelAnswer,
  type DwarfQuestionOption,
  type DwarfQuestionTextAnswer
} from '../../types'

/**
 * Choosing one of the answers an agent said it would take, and turning that
 * choice into the request main can hand back to the blocked tool call (#125).
 *
 * Pure, so the two rules that are easy to get wrong in a template are unit
 * tested instead of eyeballed: a selection belongs to ONE ask and never carries
 * into the next, and selecting is not sending.
 */

/** The line the panel shows once something is selected. Enter is what sends it. */
export const PRESS_ENTER_TO_SEND = 'Press ENTER to send'

/**
 * The control a multi-select ask sends through (#362).
 *
 * A button rather than Enter, and that is the point rather than a style: what
 * a toggle changes is a SET, so there is no moment at which the panel could
 * read a keypress as "this is my answer now". Nothing is typed into somebody's
 * console until this is pressed.
 */
export const SEND_ANSWER_NAME = 'Answer'

/**
 * What the user has chosen, and which ask they chose it for.
 *
 * The id travels with the label because the panel always shows whatever ask is
 * outstanding NOW: an agent that withdrew one question and asked another would
 * otherwise inherit a choice made against text nobody read.
 */
export interface QuestionSelection {
  toolUseId: string
  label: string
}

/** How one option card is drawn — the design's three states, in its own words. */
export type OptionState = 'base' | 'selected' | 'dimmed'

function belongsTo(selection: QuestionSelection | null, toolUseId: string): boolean {
  return selection !== null && selection.toolUseId === toolUseId
}

/**
 * Apply a click on `label`. Clicking the selected card again clears the
 * selection: the design leaves clearing unspecified, and a second click is the
 * only affordance already on screen, so it is what a mis-click can be undone
 * with.
 */
export function selectOption(
  current: QuestionSelection | null,
  toolUseId: string,
  label: string
): QuestionSelection | null {
  if (belongsTo(current, toolUseId) && current?.label === label) return null
  return { toolUseId, label }
}

export function optionState(
  current: QuestionSelection | null,
  toolUseId: string,
  label: string
): OptionState {
  if (!belongsTo(current, toolUseId)) return 'base'
  return current?.label === label ? 'selected' : 'dimmed'
}

/**
 * A verdict may only be shown against the ask it was given for. Anything else
 * would paint one question's outcome onto another's.
 */
export function answerStateForAsk(
  state: DwarfAnswerState | undefined,
  toolUseId: string
): DwarfAnswerState | undefined {
  return state?.toolUseId === toolUseId ? state : undefined
}

/**
 * Whether this ask can still be answered at all — which is what decides whether
 * the cards are live or inert.
 *
 * False while an answer is in flight, so a second press cannot release the same
 * tool call twice, and false once one was released: the ask is gone at that
 * moment even though the card stays on screen until main's next snapshot drops
 * it. A refusal re-opens it, because nothing was handed over.
 */
export function isAnswerable(state: DwarfAnswerState | undefined, toolUseId: string): boolean {
  const verdict = answerStateForAsk(state, toolUseId)
  return verdict === undefined || verdict.phase === 'refused'
}

/** Whether Enter would send anything right now: something chosen, and still answerable. */
export function canSendAnswer(
  current: QuestionSelection | null,
  toolUseId: string,
  state: DwarfAnswerState | undefined
): boolean {
  return belongsTo(current, toolUseId) && isAnswerable(state, toolUseId)
}

/**
 * The request that answers `question` with `label`.
 *
 * Keyed by the question's TEXT and valued by the option's LABEL, exactly as the
 * agent's own tool takes it, and both repeated verbatim: main matches them
 * against the ask it actually made — in the redacted spelling the panel was
 * shown — so anything folded or trimmed here would stop matching.
 *
 * One label per question on the HELD channel, even for a multi-select ask, and
 * that is the channel's own rule rather than a simplification: how the agent's
 * own picker joins several answers is unmeasured, and inventing a separator
 * would make it read an answer nobody gave (see resolveAnswers in main).
 *
 * On the terminal channel `label` may be several labels joined, because there
 * the answer is a measured keystroke per option rather than a record handed to
 * a tool — see toggledAnswer, which is what builds that value, and
 * joinAnswerLabels in contracts, which is the encoding both sides read. This
 * function is unchanged by it: what it takes is one answer VALUE, and it still
 * repeats it verbatim.
 */
export function answerRequest(
  dwarfId: string,
  question: DwarfQuestion,
  label: string
): DwarfQuestionLabelAnswer {
  return {
    dwarfId,
    toolUseId: question.toolUseId,
    answers: { [question.question]: label }
  }
}

/**
 * The request that answers `question` in the person's OWN words (#481).
 *
 * `answerRequest`'s sibling and the other of the wire's two exclusive forms: no
 * record, because there is nothing for a key to distinguish — this answers the
 * one question on the wire, through the "Other" row that question's own picker
 * offers. Main types it there (see questionFreeTextChunks); it is not a message
 * and never travels the message path.
 *
 * The words are repeated exactly, for the reason the label is: main writes what
 * this carries into somebody's console, and anything trimmed or folded here
 * would be a sentence the person did not write. Refusing what cannot be typed —
 * a line break, an escape, nothing at all — belongs to main, where the
 * measurement is.
 */
export function textAnswerRequest(
  dwarfId: string,
  question: DwarfQuestion,
  text: string
): DwarfQuestionTextAnswer {
  return { dwarfId, toolUseId: question.toolUseId, text }
}

/**
 * Where a card's free-text box would really send what is typed into it (#481).
 *
 * Not a style choice and not a capability: it is the same reading of one fact
 * both cards need, so it is decided once here rather than as a `channel ===`
 * in two templates that could drift apart.
 *
 * - `'message'` — the held channel, unchanged since #125. The words are queued
 *   on the stream this panel owns, the agent reads them as its user's, and no
 *   picker is anywhere near them.
 * - `'answer'` — a watched session whose ask has a MEASURED route to its
 *   picker's own "Other" row. The words go as an ANSWER rather than a message:
 *   main reaches that row, types them, and presses Enter once (measured
 *   2026-09-18 — see questionFreeTextChunks in main). This is the row the
 *   agent's own picker offers for exactly this, so nothing here is invented.
 * - `'picker'` — every other watched prompt, and the reason the box is refused
 *   there. The ordinary message path writes into the session's OWN console, and
 *   a session drawing a picker reads those keys as picker input: the letters do
 *   nothing visible, a digit among them jumps to an option, and the Enter that
 *   ends the message confirms whichever option is highlighted. The person's
 *   words are lost and the agent is handed a choice nobody made — see
 *   TYPED_HERE_REACHES_THE_PICKER, which is what the cards show instead.
 *
 * `ask` is `null` for a prompt that is not a question at all: a permission
 * dialog's y/n has no Other row, so there is nothing for a box there to reach.
 *
 * - `'closed'` — an OpenCode permission dialog (#588 T5). No question has ever
 *   reached this channel (only OpenCode's own permission asks stamp it), so
 *   this is reached from the permission card alone. It is NOT the same
 *   refusal as `'picker'`: there is no console reading stray keys here, so
 *   `TYPED_HERE_REACHES_THE_PICKER` would be a claim about a picker that does
 *   not exist (review finding F2). What is real, and measured
 *   (docs/opencode-format.md Row 13), is that a message sent while this
 *   dialog is open risks racing a second `opencode run --session` against the
 *   turn that is still waiting — see OPENCODE_PERMISSION_ANSWERED_ABOVE.
 *
 * Off the prompt's own `channel` and nothing weaker, exactly as the cards'
 * other terminal rules are: that field is main's own reading of where the
 * prompt is being drawn, and the renderer may not re-derive it (see
 * DwarfPromptChannel). The ask's SHAPE is the other half, and it is read
 * through `askHasAReachableOtherRow` — the same function main builds the keys
 * from, because a box a person may type into that main would then refuse is
 * the worse of the two failures available here.
 */
export type FreeTextRoute = 'message' | 'answer' | 'picker' | 'closed'

export function freeTextRoute(
  channel: DwarfPromptChannel,
  ask: DwarfQuestion | null
): FreeTextRoute {
  if (channel === 'held') return 'message'
  if (channel === 'opencode-permission') return 'closed'
  return ask !== null && askHasAReachableOtherRow(ask) ? 'answer' : 'picker'
}

/**
 * What is toggled on a multi-select ask, and which ask it was toggled for
 * (#362).
 *
 * A SIBLING of QuestionSelection rather than a widening of it, because the two
 * gestures are different gestures: a selection is one choice that replaces the
 * last, and this is a set that grows and shrinks. Folding them together would
 * have meant every reader of a selection asking "one or several?" before it
 * could draw anything — and the permission card, which reuses the selection
 * helpers as they are, would have had to ask it too.
 *
 * The ask's id travels with the labels for the reason it does there: the panel
 * always shows whatever ask is outstanding NOW, and toggles made against text
 * nobody read must not carry into the next one.
 */
export interface QuestionToggles {
  toolUseId: string
  labels: readonly string[]
}

function togglesFor(current: QuestionToggles | null, toolUseId: string): readonly string[] {
  return current !== null && current.toolUseId === toolUseId ? current.labels : []
}

/**
 * Apply a click on `label`: on if it was off, off if it was on.
 *
 * Clicking a toggled option again clears just that one, where the single-select
 * `selectOption` clears the whole selection — the same affordance in both
 * cases, doing the thing that undoes one click.
 */
export function toggleOption(
  current: QuestionToggles | null,
  toolUseId: string,
  label: string
): QuestionToggles {
  const labels = togglesFor(current, toolUseId)
  return {
    toolUseId,
    labels: labels.includes(label) ? labels.filter((entry) => entry !== label) : [...labels, label]
  }
}

/**
 * How one toggle is drawn. Only two of the three states are reachable: an
 * option nobody has toggled is in its BASE state rather than dimmed, because
 * the design's dimmed state says "passed over" and a toggle nobody has reached
 * for yet has not been passed over — every other option is still available.
 */
export function toggleState(
  current: QuestionToggles | null,
  toolUseId: string,
  label: string
): OptionState {
  return togglesFor(current, toolUseId).includes(label) ? 'selected' : 'base'
}

/** Whether the Answer control would send anything: something toggled, and still answerable. */
export function canSendToggles(
  current: QuestionToggles | null,
  toolUseId: string,
  state: DwarfAnswerState | undefined
): boolean {
  return togglesFor(current, toolUseId).length > 0 && isAnswerable(state, toolUseId)
}

/**
 * The one answer value every toggled label rides in, or null when there is
 * nothing to send.
 *
 * Ordered by the ask's OWN options rather than by the order they were clicked
 * in: main presses a digit per option position, and the sequence has to be
 * deterministic from the picker's initial state — where a person reached first
 * is not part of that state.
 *
 * A label the ask does not offer is dropped rather than carried. Unreachable
 * through the card's own buttons, and main would refuse it anyway: this channel
 * takes back only the agent's own words.
 */
export function toggledAnswer(
  current: QuestionToggles | null,
  question: DwarfQuestion
): string | null {
  const toggled = togglesFor(current, question.toolUseId)
  const labels = question.options
    .map((option) => option.label)
    .filter((label) => toggled.includes(label))
  return labels.length === 0 ? null : joinAnswerLabels(labels)
}

/**
 * The line the panel shows under a released answer. Failures are absent on
 * purpose, exactly as in deliveryVerdict: the panel renders those through its
 * own alert row, which carries main's reason verbatim.
 */
export function answerStatusLine(state: DwarfAnswerState | undefined): string | null {
  if (state?.phase !== 'answered') return null
  return 'Handed to the agent — its blocked ask was released with this choice.'
}

/**
 * Claude Code's own two answers to a permission prompt (#203) — fixed rather
 * than agent-supplied, because a permission's model wrote nothing to choose
 * between (see DwarfPermissionRequest). Deliberately not a third "always
 * allow": that answer writes a rule into the user's settings, and this card
 * offers nothing that outlives the prompt.
 *
 * The selection helpers above (selectOption, optionState, canSendAnswer,
 * isAnswerable, answerStateForAsk) are reused as-is for this list: they are
 * keyed by toolUseId, and a permission's toolUseId is exactly as good a key
 * as a question's.
 */
export const PERMISSION_OPTIONS: readonly DwarfQuestionOption[] = [
  { label: 'Allow', description: 'Run this tool call exactly as the agent wrote it.' },
  { label: 'Deny', description: 'Refuse it. The agent is told the panel declined.' }
]

/**
 * The decision one of PERMISSION_OPTIONS' labels names, or null for anything
 * else. The boundary between a label a person clicked and the closed
 * vocabulary DwarfPermissionDecision admits — same reason the shared
 * contracts' `isMineTier` and friends exist as values rather than casts.
 */
export function decisionForLabel(label: string): DwarfPermissionDecision | null {
  if (label === 'Allow') return 'allow'
  if (label === 'Deny') return 'deny'
  return null
}

/**
 * The request that releases `permission`'s blocked tool call with `decision`.
 *
 * Addressed by the prompt's own toolUseId, exactly as answerRequest is by the
 * question's: a decision naming a prompt that has since closed must be
 * refused by main rather than re-aimed at whatever is open now.
 */
export function permissionRequest(
  dwarfId: string,
  permission: DwarfPermissionRequest,
  decision: DwarfPermissionDecision
): DwarfPermissionAnswerRequest {
  return { dwarfId, toolUseId: permission.toolUseId, decision }
}

/**
 * The three things the panel can honestly say under a given decision, one per
 * channel and — on the terminal channel — one per decision (#203).
 *
 * The held sentence is the strongest claim of the three and still a narrow
 * one: the blocked call was released, never what the agent then did with it.
 *
 * Neither terminal sentence may borrow it, because the evidence is weaker.
 * The panel pressed a key in a console it does not own; the session acting on
 * that key is a separate fact, and the only proof of it is the transcript
 * writing the matching `tool_result` — which is exactly when main stops
 * naming the prompt and the card leaves. So the ✓ here is "typed" and the ✓✓
 * is the card going.
 *
 * The deny sentence carries one more thing, and it is a warning rather than a
 * verdict: Deny is Esc (measured — see main's textDelivery/permissionKeys),
 * and Esc has a second meaning on a session whose dialog was answered at the
 * terminal a moment earlier — it interrupts the turn the allowed tool is
 * running in. Bounded and accepted, since somebody pressing Deny wanted that
 * tool not to run, but said out loud rather than left to be discovered.
 */
export const PERMISSION_RELEASED_LINE =
  'Handed to the agent — its blocked tool call was released with this decision.'
export const PERMISSION_TYPED_LINE = 'Typed at the terminal — waiting for the session to act on it.'
export const PERMISSION_ESCAPED_LINE =
  'Typed Esc at the terminal — if the prompt was already answered there, ' +
  'this interrupts the turn instead.'
/**
 * The OpenCode channel's own sentence (#588 T5) — weaker than the held
 * channel's PERMISSION_RELEASED_LINE (this app posted to a server it does not
 * own, not released a call through a stream it does), and different evidence
 * from the terminal channel's typed-keystroke pair: OpenCode's own reply
 * vocabulary ('once'/'reject') carries no second meaning the way Esc does, so
 * one line serves both Allow and Deny rather than needing PERMISSION_ESCAPED_
 * LINE's own warning.
 */
export const PERMISSION_SENT_TO_OPENCODE_LINE =
  "Sent to OpenCode's own server — waiting for the session to act on it."

/**
 * The line the panel shows under a released decision, or null when there is
 * nothing yet to say. A refusal is absent on purpose, exactly as in
 * deliveryVerdict: the panel renders those through its own alert row, which
 * carries main's reason verbatim.
 *
 * `channel` is the request's own, from the wire, rather than anything derived
 * here — see DwarfPermissionRequest.channel for why main is the only place
 * that can know it.
 */
export function permissionStatusLine(
  state: DwarfAnswerState | undefined,
  channel: DwarfPromptChannel
): string | null {
  if (state?.phase !== 'answered') return null
  if (channel === 'held') return PERMISSION_RELEASED_LINE
  if (channel === 'opencode-permission') return PERMISSION_SENT_TO_OPENCODE_LINE
  // Allow's wording is the fallback for a verdict carrying no decision, which
  // `decide` never produces: it claims a keypress and nothing about a turn,
  // so it is the one that cannot overstate.
  return state.decision === 'deny' ? PERMISSION_ESCAPED_LINE : PERMISSION_TYPED_LINE
}
