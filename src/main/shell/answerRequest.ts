/**
 * The boundary that reads an answer the panel gives to an agent's question (#125, #481).
 *
 * Pure and Electron-free on purpose, like `panelBounds.ts` beside it: every refusal below is
 * assertable without a display, and `index.ts` keeps the three-line handler it would otherwise
 * have grown a validator inside.
 *
 * MOVED here for #635 from messagePanelState.ts, whole, when that file's other parsers went with
 * the message panel's own window: the surface main held for both windows, its height report and
 * the delivery report it relayed (#162). This one never was about the window — it reads an answer
 * the window gave back — so it outlived it, and the file is named for what it still reads.
 */
import { MAX_DWARF_TEXT_CHARS, type DwarfQuestionAnswerRequest } from '../domain/types'

/** The record form: every key and value a string pair, or no answer at all. */
function parseAnswerRecord(payload: unknown): Record<string, string> | null {
  if (typeof payload !== 'object' || payload === null) return null
  const answers: Record<string, string> = {}
  for (const [question, label] of Object.entries(payload as Record<string, unknown>)) {
    // One malformed entry takes the whole answer down rather than being
    // dropped — a partly-read answer is one the panel would be answering
    // differently from how the person did.
    if (typeof label !== 'string') return null
    answers[question] = label
  }
  return answers
}

/**
 * Read an answer the panel gave to an agent's question, or refuse it
 * (#125, #481).
 *
 * Here rather than in `index.ts`, where it lived until #481, for the reason
 * every parser in this file is here: an answer releases a tool call a live
 * agent is blocked inside, and the refusals below are worth asserting without
 * an Electron window in front of them.
 *
 * ## Exactly one of the two forms
 *
 * The LABEL form is a RECORD of strings, which no other channel carries: keyed
 * by the question's text, valued by one of the agent's own option labels. The
 * TEXT form is #481's, and it is the person's own words for the picker's
 * "Other" row. A payload carrying BOTH is refused rather than resolved in some
 * order, because it could not say which answer it meant and choosing one would
 * be main answering on the person's behalf; a payload carrying NEITHER answers
 * nothing.
 *
 * ## What is judged here, and what is not
 *
 * A SHAPE and never a choice — the rule this parser has held since #125. What
 * the strings MEAN is matched against the ask the agent actually made, in the
 * runtime, where the ask is; so an empty record passes here and is refused
 * there as an answer that chose nothing.
 *
 * The text's two checks are shape checks on the same terms. An EMPTY string is
 * a field that could not say anything, and the wire ceiling is the widest bound
 * certainly true of the route (`MAX_DWARF_TEXT_CHARS`, #431). Whitespace alone
 * is content rather than shape, and it is refused where the keys are built,
 * with the sentence that is true of it.
 */
export function parseAnswerRequest(payload: unknown): DwarfQuestionAnswerRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  if (typeof record.dwarfId !== 'string' || typeof record.toolUseId !== 'string') return null
  const address = { dwarfId: record.dwarfId, toolUseId: record.toolUseId }

  const hasText = record.text !== undefined
  const hasAnswers = record.answers !== undefined
  if (hasText === hasAnswers) return null

  if (hasText) {
    if (typeof record.text !== 'string') return null
    if (record.text === '' || record.text.length > MAX_DWARF_TEXT_CHARS) return null
    return { ...address, text: record.text }
  }

  const answers = parseAnswerRecord(record.answers)
  return answers === null ? null : { ...address, answers }
}
