import type { DwarfAnswerState, DwarfQuestion, DwarfQuestionAnswerRequest } from '../../types'

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
