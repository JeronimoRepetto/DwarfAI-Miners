import type {
  DwarfAnswerState,
  DwarfPermissionAnswerRequest,
  DwarfPermissionChannel,
  DwarfPermissionDecision,
  DwarfPermissionRequest,
  DwarfQuestion,
  DwarfQuestionAnswerRequest,
  DwarfQuestionOption
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
 * One label even for a multi-select ask. That is the channel's own rule, not a
 * simplification: how a picker joins several answers is unmeasured, and
 * inventing a separator would make the agent read an answer nobody gave.
 */
export function answerRequest(
  dwarfId: string,
  question: DwarfQuestion,
  label: string
): DwarfQuestionAnswerRequest {
  return {
    dwarfId,
    toolUseId: question.toolUseId,
    answers: { [question.question]: label }
  }
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
  channel: DwarfPermissionChannel
): string | null {
  if (state?.phase !== 'answered') return null
  if (channel === 'held') return PERMISSION_RELEASED_LINE
  // Allow's wording is the fallback for a verdict carrying no decision, which
  // `decide` never produces: it claims a keypress and nothing about a turn,
  // so it is the one that cannot overstate.
  return state.decision === 'deny' ? PERMISSION_ESCAPED_LINE : PERMISSION_TYPED_LINE
}
