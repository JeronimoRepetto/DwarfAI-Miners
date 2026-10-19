// ACP form elicitation (`elicitation/create`, mode `form`) ↔ the question card (15 §2.7 Questions
// row "ACP form elicitation from AskUserQuestion", frozen; `clacp@e6681d2:src/elicitation.ts`).
// The form's `question_<n>` properties are the steps (in `n` order), each answered with an option
// label; `question_<n>_custom` carries free text. A step shows its question: the property's
// `description` (claude-agent-acp writes each question there when the form has several), else the
// form's `message` (its single question), else the property's `title` (the short header).
// `{ decline: true }` sends the elicitation `decline` (ADR-009 D3); an empty answers array is an
// ordinary accept, never a decline. A form
// with no `question_<n>` property is not a question card: the request is refused (fail closed).
// Pure: no I/O.
import type {
  QuestionAnswers,
  QuestionPayload
} from '../../../../../../kernel/domain/sharedContracts'

/** One step of a form: its property names and the option labels it accepts. */
export interface FormQuestion {
  readonly property: string
  /** `question_<n>_custom` when the form has it. */
  readonly customProperty: string | null
  /** The labels an `option` answer may be; empty for a free-text-only property. */
  readonly options: readonly string[]
}

export interface ElicitationForm {
  readonly payload: QuestionPayload
  readonly questions: readonly FormQuestion[]
}

/** The reply to `elicitation/create`. */
export type ElicitationReply =
  | { readonly action: 'accept'; readonly content: Readonly<Record<string, string>> }
  | { readonly action: 'decline' }
  | { readonly action: 'cancel' }

export const DECLINE: ElicitationReply = Object.freeze({ action: 'decline' })
/** The turn was cancelled while the form was open (HR A7). */
export const CANCEL: ElicitationReply = Object.freeze({ action: 'cancel' })

/** The question card of a form elicitation, or null when the request is not one. */
export function formOf(request: {
  readonly mode?: unknown
  readonly message?: unknown
  readonly requestedSchema?: unknown
}): ElicitationForm | null {
  if (request.mode !== 'form' || !isRecord(request.requestedSchema)) return null
  const properties = request.requestedSchema.properties
  if (!isRecord(properties)) return null
  const message = typeof request.message === 'string' ? request.message : ''
  const numbered: { n: number; question: FormQuestion; schema: Record<string, unknown> }[] = []
  for (const [name, schema] of Object.entries(properties)) {
    const match = QUESTION_PROPERTY.exec(name)
    if (match === null) continue
    if (!isRecord(schema)) return null
    const options = optionLabels(schema)
    if (options === null) return null
    const custom = `${name}_custom`
    numbered.push({
      n: Number(match[1]),
      schema,
      question: {
        property: name,
        customProperty: isRecord(properties[custom]) ? custom : null,
        options
      }
    })
  }
  if (numbered.length === 0) return null
  numbered.sort((a, b) => a.n - b.n)
  return {
    payload: {
      steps: numbered.map(({ schema, question }) => ({
        text: textOf(schema, numbered.length === 1 ? message : '') ?? message,
        options: [...question.options],
        allowsFreeText: true
      }))
    },
    questions: numbered.map(({ question }) => question)
  }
}

/** The accept reply for `answers`, or `invalid-answer` when they do not fit the form. */
export function answerReply(
  form: ElicitationForm,
  answers: QuestionAnswers
): ElicitationReply | 'invalid-answer' {
  const content: Record<string, string> = {}
  for (const answer of answers) {
    const question = form.questions[answer.step]
    if (question === undefined) return 'invalid-answer'
    if (answer.option !== undefined) {
      if (!question.options.includes(answer.option)) return 'invalid-answer'
      content[question.property] = answer.option
    }
    if (answer.freeText !== undefined) {
      if (question.customProperty !== null) content[question.customProperty] = answer.freeText
      else if (question.options.length === 0 && answer.option === undefined) {
        content[question.property] = answer.freeText
      } else return 'invalid-answer'
    }
  }
  return { action: 'accept', content }
}

/** `question_<n>`, the step properties of a form; `question_<n>_custom` is a step's free text. */
const QUESTION_PROPERTY = /^question_(\d+)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A step's question: its `description`, else the single question's `message`, else its `title`. */
function textOf(schema: Record<string, unknown>, message: string): string | null {
  for (const value of [schema.description, message, schema.title]) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/** The option labels of a step: its `enum`, or its `oneOf` / `anyOf` consts; null when malformed. */
function optionLabels(schema: Record<string, unknown>): string[] | null {
  if (schema.enum !== undefined) {
    const values = schema.enum
    return Array.isArray(values) && values.every((v) => typeof v === 'string') ? [...values] : null
  }
  const choices = schema.oneOf ?? schema.anyOf
  if (choices === undefined) return []
  if (!Array.isArray(choices)) return null
  const labels: string[] = []
  for (const choice of choices) {
    if (!isRecord(choice) || typeof choice.const !== 'string') return null
    labels.push(choice.const)
  }
  return labels
}
