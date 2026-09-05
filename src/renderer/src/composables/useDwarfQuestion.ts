import { reactive } from 'vue'
import { answerRequest, permissionRequest } from '../lib/question/questionAnswer'
import {
  defaultDwarfQuestionState,
  type DwarfAnswerState,
  type DwarfPermissionDecision,
  type DwarfPermissionRequest,
  type DwarfQuestion,
  type DwarfQuestionAnswerResult
} from '../types'

/**
 * The verdict of an answer the panel gave to an agent's question (#94, #125),
 * or a decision it gave on a permission prompt (#203) — ONE store for both,
 * because a verdict is about a toolUseId, whichever kind of prompt named it.
 * `answer` and `decide` differ only in which wire request they build and which
 * bridge method they call; both write the exact same DwarfAnswerState shape,
 * keyed by dwarf, and neither cares what the other last wrote there.
 *
 * Deliberately shorter than useDwarfMessaging, and the difference is the whole
 * point. A message is watched across later polls because a relay can offer no
 * proof a session read it; a verdict here needs none, because main releases
 * the agent's own blocked tool call and reports whether that happened. There
 * is no reaction to observe here and none to invent — routing this through a
 * watch would throw away the stronger fact to reconstruct a weaker one.
 *
 * What a verdict never touches is the PROMPT. The card on screen is drawn from
 * the dwarf's own `pendingQuestion` or `pendingPermission`, which only main's
 * next snapshot can drop: a store that hid one on a successful send would be
 * claiming the prompt was closed on the strength of its own optimism.
 */

// Singleton store: module-scope state shared by every useDwarfQuestion()
// caller, exactly as the messaging and kicking stores are.
const state = reactive(defaultDwarfQuestionState())

const LOST_BRIDGE = 'The panel lost contact with the app.'
const NOT_ANSWERED = 'That answer could not be delivered.'

export function useDwarfQuestion() {
  function stateFor(dwarfId: string): DwarfAnswerState | undefined {
    return state.byDwarfId[dwarfId]
  }

  /**
   * Answer `question` with the option `label`. A second call while one is still
   * in flight for the same dwarf is ignored: a double press must never release
   * the same tool call twice.
   */
  async function answer(dwarfId: string, question: DwarfQuestion, label: string): Promise<void> {
    if (state.byDwarfId[dwarfId]?.phase === 'answering') return
    const toolUseId = question.toolUseId
    state.byDwarfId[dwarfId] = { phase: 'answering', toolUseId }

    let result: DwarfQuestionAnswerResult
    try {
      result = await window.api.answerDwarfQuestion(answerRequest(dwarfId, question, label))
    } catch {
      result = { answered: false, error: LOST_BRIDGE }
    }

    state.byDwarfId[dwarfId] = result.answered
      ? { phase: 'answered', toolUseId }
      : { phase: 'refused', toolUseId, error: result.error ?? NOT_ANSWERED }
  }

  /**
   * Decide `permission` with `decision` ('allow' or 'deny'). Same in-flight
   * guard and the same store as `answer` — see the module comment: a verdict
   * is about a toolUseId, whichever kind of prompt it named, so a second call
   * while one is still in flight for the same dwarf is ignored here exactly
   * as it is there.
   */
  async function decide(
    dwarfId: string,
    permission: DwarfPermissionRequest,
    decision: DwarfPermissionDecision
  ): Promise<void> {
    if (state.byDwarfId[dwarfId]?.phase === 'answering') return
    const toolUseId = permission.toolUseId
    // The decision travels with every phase of the verdict, because what the
    // panel may say about it depends on which one it was: on a terminal
    // channel an Allow is a keypress waiting to be acted on and a Deny is an
    // Esc that may have interrupted a turn instead (#203, see
    // permissionStatusLine). An answer to a QUESTION records none — that
    // vocabulary is the permission prompt's alone.
    state.byDwarfId[dwarfId] = { phase: 'answering', toolUseId, decision }

    let result: DwarfQuestionAnswerResult
    try {
      result = await window.api.answerDwarfPermission(
        permissionRequest(dwarfId, permission, decision)
      )
    } catch {
      result = { answered: false, error: LOST_BRIDGE }
    }

    state.byDwarfId[dwarfId] = result.answered
      ? { phase: 'answered', toolUseId, decision }
      : { phase: 'refused', toolUseId, decision, error: result.error ?? NOT_ANSWERED }
  }

  function clear(dwarfId: string): void {
    delete state.byDwarfId[dwarfId]
  }

  function clearAll(): void {
    for (const dwarfId of Object.keys(state.byDwarfId)) clear(dwarfId)
  }

  return { state, answer, decide, stateFor, clear, clearAll }
}
