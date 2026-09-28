import type { DwarfPermissionRequest } from '../../types'
import { PERMISSION_OPTIONS, chosenAt, type AskAnswers, type AskShape } from './questionAnswer'

/**
 * The question card as the redesign draws it (#635, `organisms/question-card`): one card for a
 * question and for a permission, which is "the same card with one step" (components.md, Question
 * card; decision log, Permission card). What the card shows and what a key does are decided here;
 * the component draws. Choosing, walking and what an answer carries stay in questionAnswer.ts.
 */

/** The row every step ends with, whatever the agent offered (components.md, Question card). */
export const OTHER_THING_LABEL = 'Other thing…'
/** The free-answer field that row opens: its placeholder and its accessible name (copy.md). */
export const OTHER_PLACEHOLDER = 'Your answer'
export const OTHER_FIELD_NAME = 'Other answer'
/** A permission's request block is a focusable scroll region with this name (components.md). */
export const REQUEST_REGION_NAME = 'Request'
/**
 * What Submit reads while Other thing… is picked where its words are an ordinary message (decision
 * log, Permission free text): pressing it sends them as one, and the card stays.
 */
export const SEND_OTHER_NAME = 'Send'

/** The card's accessible name (copy.md, "{name} is asking"). */
export function askingName(name: string): string {
  return `${name} is asking`
}

/**
 * The mark on the head's "asks" pill: "?" for a question, "!" for a permission, matching the
 * needs-you queue (decision log, Permission card head).
 */
export function askMark(permission: boolean): '?' | '!' {
  return permission ? '!' : '?'
}

/**
 * A permission's request as the card's code block prints it: the tool and its input, joined as
 * the design writes its request ("Bash · pnpm install in feat/batch-embed…"), then the CLI's own
 * prompt sentence and subtitle, each on a line of its own, when the bridge sent them. The design
 * draws one text and the wire carries up to four fields; the order of the last two is this
 * slice's reading, not the design's (named in #635's PR).
 */
export function permissionRequestText(permission: DwarfPermissionRequest): string {
  return [`${permission.toolName} · ${permission.input}`, permission.title, permission.description]
    .filter((line): line is string => line !== undefined && line !== '')
    .join('\n')
}

/**
 * A permission as one step of the card: its request is the step's text and Allow then Deny are
 * its only decisions (decision log, Permission card). The options carry no description: the design
 * draws the two labels alone, and PERMISSION_OPTIONS' glosses are this app's words, not the agent's.
 */
export function permissionAsk(permission: DwarfPermissionRequest): AskShape {
  return {
    toolUseId: permission.toolUseId,
    questions: [
      {
        question: permissionRequestText(permission),
        multiSelect: false,
        options: PERMISSION_OPTIONS.map((option) => ({ label: option.label }))
      }
    ]
  }
}

/**
 * The option a digit key picks, as an index into the step's options, where one past the last is
 * Other thing…; or null for a key that picks nothing. The card reads single digits, so 1–9 at most
 * (components.md, Question option), and never with a modifier held, which is somebody else's
 * shortcut. `otherOffered` is false where Other thing… is closed, and then its digit does nothing.
 */
export function digitPick(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  optionCount: number,
  otherOffered: boolean
): number | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (!/^[1-9]$/.test(event.key)) return null
  const index = Number(event.key) - 1
  if (index < optionCount) return index
  return index === optionCount && otherOffered ? index : null
}

/**
 * What was typed under Other thing…, per step of ONE ask: a step with an entry has it picked, its
 * text possibly still empty. Keyed by the ask's id for AskAnswers' reason — words typed against a
 * question nobody is asking any more never carry into the next one.
 */
export interface OtherTexts {
  toolUseId: string
  texts: Readonly<Record<number, string>>
}

function textsOf(other: OtherTexts | null, toolUseId: string): Readonly<Record<number, string>> {
  return other !== null && other.toolUseId === toolUseId ? other.texts : {}
}

/** The words under Other thing… on step `index`, '' while it is picked and empty, null unpicked. */
export function otherAt(other: OtherTexts | null, toolUseId: string, index: number): string | null {
  return textsOf(other, toolUseId)[index] ?? null
}

/** Pick Other thing… on step `index`, keeping whatever was typed there before. */
export function pickOtherAt(
  other: OtherTexts | null,
  toolUseId: string,
  index: number
): OtherTexts {
  return writeOtherAt(other, toolUseId, index, otherAt(other, toolUseId, index) ?? '')
}

export function writeOtherAt(
  other: OtherTexts | null,
  toolUseId: string,
  index: number,
  text: string
): OtherTexts {
  return { toolUseId, texts: { ...textsOf(other, toolUseId), [index]: text } }
}

/** Unpick Other thing… on step `index`, and let its words go. */
export function dropOtherAt(
  other: OtherTexts | null,
  toolUseId: string,
  index: number
): OtherTexts {
  const texts = { ...textsOf(other, toolUseId) }
  delete texts[index]
  return { toolUseId, texts }
}

/**
 * Step `index` of this ask with nothing chosen: picking Other thing… takes the options' place, as
 * picking an option takes its, so a step holds one answer, never a label and words at once.
 */
export function clearChosenAt(
  answers: AskAnswers | null,
  toolUseId: string,
  index: number
): AskAnswers {
  const kept = answers !== null && answers.toolUseId === toolUseId ? answers.chosen : {}
  return { toolUseId, chosen: { ...kept, [index]: [] } }
}

/** Whether step `index` holds an answer: a label, or words under Other thing… once trimmed. */
export function stepAnswered(
  ask: AskShape,
  index: number,
  answers: AskAnswers | null,
  other: OtherTexts | null
): boolean {
  if (chosenAt(answers, ask.toolUseId, index).length > 0) return true
  return (otherAt(other, ask.toolUseId, index) ?? '').trim() !== ''
}

export type StepDot = 'here' | 'done' | 'open'

/** The walk's dots: the step shown, each other answered one done, the rest open. */
export function stepDots(
  ask: AskShape,
  at: number,
  answers: AskAnswers | null,
  other: OtherTexts | null
): StepDot[] {
  return ask.questions.map((_, index) =>
    index === at ? 'here' : stepAnswered(ask, index, answers, other) ? 'done' : 'open'
  )
}
