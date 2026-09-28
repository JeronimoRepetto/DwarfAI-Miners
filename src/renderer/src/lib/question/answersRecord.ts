import {
  splitAnswerLabels,
  type DwarfPermissionDecision,
  type DwarfPermissionRequest,
  type DwarfQuestion
} from '../../types'
import { PERMISSION_OPTIONS, type AskAnswer, type OwnWordsAnswer } from './questionAnswer'
import { permissionRequestText } from './questionCard'

/**
 * The "Answers:" record (#635; decision log, Answers bubble is a record, MESSAGE-QUESTIONS 8):
 * what the conversation draws once a question or a permission is submitted. It is the RECORD of
 * what was answered, never a message: the answer itself leaves on the ask's own channel (the
 * question tool's result, the prompt, a permission's decision), and this text never reaches the
 * session. So it is written for the person's eyes in exactly the design's Markdown, and nothing
 * on the wire is built from it.
 *
 * The shape (screens/message.md, As built): the line "Answers:", a blank line, then one list item
 * per step in step order, "- ", the step's text with one trailing "?" removed, ": ", and the
 * answer in bold. A permission is one such item, its request as the text and Allow or Deny as the
 * answer.
 */

/** The record's first line (screens/message.md). */
export const ANSWERS_HEADING = 'Answers:'

/**
 * One step's text as the record prints it: one trailing "?" removed, as the design writes it, and
 * its lines joined by a space. A line break inside a list item would end the bubble's list, which
 * the bubble's Markdown makes only of lines that each start with "- " (components.md, Chat bubble,
 * As built), and it joins a paragraph's lines with a space the same way.
 */
function stepText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\?$/, '')
}

function recordOf(items: readonly { text: string; answer: string }[]): string {
  return [
    ANSWERS_HEADING,
    '',
    ...items.map((item) => `- ${stepText(item.text)}: **${item.answer}**`)
  ].join('\n')
}

/**
 * A step's answer as the record prints it: the person's own words where they gave them, or the
 * label chosen. A multi-select value carries several labels joined by the wire's line break
 * (joinAnswerLabels), which would end the list item; they are listed with ", ", the spelling the
 * agent SDK documents for a multi-select answer.
 */
function answerText(value: string | OwnWordsAnswer): string {
  if (typeof value !== 'string') return value.ownWords
  return splitAnswerLabels(value).join(', ')
}

/**
 * The record of an answer submitted on the question card: one item per question of the ask, with
 * the value the card handed up for it (AskAnswer: one label for a one-question ask, or one value
 * per question). A question the answer holds no value for is left out rather than guessed at; the
 * card sends nothing until every step is answered.
 */
export function questionAnswersRecord(question: DwarfQuestion, answer: AskAnswer): string {
  const values = typeof answer === 'string' ? [answer] : answer
  const items = question.questions.flatMap((asked, index) => {
    const value = values[index]
    return value === undefined ? [] : [{ text: asked.question, answer: answerText(value) }]
  })
  return recordOf(items)
}

/** The record of a one-question ask answered in the person's own words, at a terminal (#481). */
export function wordsAnswerRecord(question: DwarfQuestion, text: string): string {
  return questionAnswersRecord(question, [{ ownWords: text }])
}

/**
 * The record of a permission's decision: one item, the request as the card prints it, and the
 * label of the decision given (Allow or Deny, PERMISSION_OPTIONS).
 */
export function permissionAnswerRecord(
  permission: DwarfPermissionRequest,
  decision: DwarfPermissionDecision
): string {
  const label = PERMISSION_OPTIONS[decision === 'allow' ? 0 : 1]!.label
  return recordOf([{ text: permissionRequestText(permission), answer: label }])
}
