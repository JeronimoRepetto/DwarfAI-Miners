// The "Answers:" record's text (ADR-010 items 2, 13; US-ASK-001.AC11, US-ASK-002.AC07,
// US-ASK-003.AC07): the line "Answers:", a blank line, then one list line per step in step order,
// "- ", the step's text with one trailing "?" removed, ": ", and the answer in bold. A permission
// is one such line: its request as the text and Allow or Deny as the answer. Pure: no I/O, no clock
// read (05 §2.2, R1).
//
// The format is the renderer's tested one (`renderer/src/lib/question/answersRecord.ts`; 05 §3.7
// "Domain ← renderer `lib/question` rules"), which matches US-ASK-001.AC11, so it is kept as is:
// a step's lines are joined by a space (a line break would end the list item), and every character
// the chat bubble's Markdown would read as formatting is escaped, so the words show as written. A
// permission's request reads `<toolName> · <requestText>`, as the card prints it, and its decision
// carries the card's labels (design: Permission card).
import type {
  PermissionPayload,
  QuestionAnswers,
  QuestionPayload
} from '../../../kernel/domain/sharedContracts'
import type { PermissionDecision } from './permissionOptions'

/** The record's first line (design: screens/message.md). */
export const ANSWERS_HEADING = 'Answers:'

/** The card's label of each decision (design: Permission card). */
const DECISION_LABEL: Readonly<Record<PermissionDecision, string>> = {
  allow: 'Allow',
  deny: 'Deny'
}

/** A step's text on one line, with one trailing "?" removed. */
function stepText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\?$/, '')
}

/** Escapes what the bubble's Markdown (CommonMark) would read as formatting, so it renders as itself. */
function literal(text: string): string {
  return text
    .replace(/[\\`*_~[\]!<>&|]/g, (c) => `\\${c}`)
    .replace(/^[-+#]/, (c) => `\\${c}`)
    .replace(/^(\d+)([.)])/, '$1\\$2')
}

function recordOf(items: readonly { text: string; answer: string }[]): string {
  return [
    ANSWERS_HEADING,
    '',
    ...items.map((item) => `- ${literal(stepText(item.text))}: **${literal(item.answer)}**`)
  ].join('\n')
}

/**
 * The record of a question's answers: one line per answered step, in step order, the person's own
 * words where they gave them (US-ASK-002.AC07), else the option picked. An answer for a step the
 * question does not have is left out rather than guessed at.
 */
export function questionRecordText(payload: QuestionPayload, answers: QuestionAnswers): string {
  const items = [...answers]
    .sort((a, b) => a.step - b.step)
    .flatMap((answer) => {
      const step = payload.steps[answer.step]
      const value = answer.freeText ?? answer.option
      return step === undefined || value === undefined ? [] : [{ text: step.text, answer: value }]
    })
  return recordOf(items)
}

/** The record of a permission's decision: its request and Allow or Deny in bold. */
export function permissionRecordText(
  payload: PermissionPayload,
  decision: PermissionDecision
): string {
  return recordOf([
    { text: `${payload.toolName} · ${payload.requestText}`, answer: DECISION_LABEL[decision] }
  ])
}
