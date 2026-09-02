import { reactive } from 'vue'
import { answerRequest } from '../lib/question/questionAnswer'
import {
  defaultDwarfQuestionState,
  type DwarfAnswerState,
  type DwarfQuestion,
  type DwarfQuestionAnswerResult
} from '../types'

/**
 * The verdict of an answer the panel gave to an agent's question (#94, #125).
 *
 * Deliberately shorter than useDwarfMessaging, and the difference is the whole
 * point. A message is watched across later polls because a relay can offer no
 * proof a session read it; an answer needs none, because main releases the
 * agent's own blocked tool call and reports whether that happened. There is no
 * reaction to observe here and none to invent — routing this through a watch
 * would throw away the stronger fact to reconstruct a weaker one.
 *
 * What the verdict never touches is the QUESTION. The card on screen is drawn
 * from the dwarf's own `pendingQuestion`, which only main's next snapshot can
 * drop: a store that hid it on a successful send would be claiming the ask was
 * closed on the strength of its own optimism.
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

  function clear(dwarfId: string): void {
    delete state.byDwarfId[dwarfId]
  }

  function clearAll(): void {
    for (const dwarfId of Object.keys(state.byDwarfId)) clear(dwarfId)
  }

  return { state, answer, stateFor, clear, clearAll }
}
