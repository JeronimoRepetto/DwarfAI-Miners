// The turn outcome line (06 §9.2 `OutcomeLine`, INV-67; US-MSG-011): one line per dwarf, replaced at
// every turn change, derived by one pure rule. Pure: no I/O, no clock read (05 §2.2, R1): every
// instant is passed in.
//
// The aggregate is 06 §9.2's, field for field as the wire copy in `contracts/wire` (`OutcomeLine`,
// `OutcomeLinePart`, `TurnOutcomeKind`): the Host core never imports `contracts` (R9), so the domain
// holds it as `ActivityDisclosure` and `Message` are held; the transport mapper that puts it on
// `DwarfWire.outcome` holds the two equal (mappers/wire.types.test.ts). `OutcomeStatus` is crew's
// `DwarfStatus` (ADR-032 item 2), referenced, not restated: a type test holds it equal.
//
// The rule, in order:
// - `asking`: `waiting-on-you`, with the front ask's question count or `permission` (AC02).
// - `working`: `working`; right after the person's answer is released "answers received", once that
//   answers message is seen handed over "reading your message" (AC03, AC04, AMENDMENT-10); otherwise
//   the open run's steps so far, from one step on (AC01, AC13, AC14).
// - `idle` / `asleep` after a reliable end: the end's own kind (AC05, AC11), the total steps of every
//   run since the person's last message when there is one to count (AC10, AC11), and the instant it
//   ended (`idle-since`), which the text rule words live, so no Host timer refreshes it (NFR-TIM-15),
//   left out for an observed session with no end time (AC09). The provider's `detail` and, for a
//   concluded turn, its closing words (trimmed to 200 chars) go to the tooltip fields only, never a
//   part (AC06, INV-67).
// - `idle` / `asleep` with no reliable end (an inferred end, or no end yet): ADR-021 item 3 leaves
//   out the end wording and the idle part. Package gap resolved in development: 06 §9.2's six kinds
//   have no kind for this line, and the four end kinds are the end wording; the line keeps kind
//   `working` with `reliability: 'inferred'` and only the observed step count, and what it reads is
//   the open design item of US-MSG-011 (FUNCTIONAL-SPEC §9), worded by the text rule.
import type { TurnEnded, TurnEndKind } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, Instant } from '../../../kernel/domain/values'

/** 06 §9.2 `TurnOutcomeKind`: exactly these six (ADR-021 D1 `TurnEndKind` + the in-progress kinds). */
export type TurnOutcomeKind = 'working' | 'waiting-on-you' | TurnEndKind

/** 06 §9.2: the closed part union, worded from US-MSG-011 by `contracts/text/outcomeLine.ts`. */
export type OutcomeLinePart =
  | { kind: 'steps'; n: number }
  | { kind: 'steps-so-far'; n: number }
  | { kind: 'waiting-questions'; n: number }
  | { kind: 'waiting-permission' }
  | { kind: 'answers-received' }
  | { kind: 'reading-your-message' }
  | { kind: 'idle-since'; at: Instant }

/** 06 §9.2 `OutcomeLine` (one per dwarf; 09 §4.4 `outcome_lines`). */
export interface OutcomeLine {
  dwarfId: DwarfId
  kind: TurnOutcomeKind
  /**
   * The steps of every run since the person's last message (10 `outcome_lines.step_count`, "steps in
   * the turn"): the running total the next recompute adds to (16 §4.6 amendment B). A working line
   * shows its open run's count in its `steps-so-far` part instead.
   */
  stepCount: number
  /** At most three (06 §9.2; 09 `parts_json` CHECK). */
  parts: OutcomeLinePart[]
  /** The provider's own word, tooltip only. */
  detail?: string
  /** A concluded turn's closing words, tooltip only, trimmed to 200 chars. */
  closingWords?: string
  reliability: 'reliable' | 'inferred'
  /** When the turn ended; for a line of a turn in progress, the instant it was derived. */
  at: Instant
}

/** Crew's `DwarfStatus` (ADR-032 item 2; PO #9: never `done`). */
export type OutcomeStatus = 'working' | 'asking' | 'idle' | 'asleep'

/** The dwarf's front ask (07 S1.10; ADR-010 item 7). */
export type FrontAsk = { kind: 'question'; questionCount: number } | { kind: 'permission' }

export interface OutcomeInput {
  dwarfId: DwarfId
  status: OutcomeStatus
  /** The dwarf's open activity run (07 §11), or null. */
  openRun: { stepCount: number } | null
  /** Steps of every run since the person's last message (US-MSG-011 "Turn step count"). */
  stepsSinceLastPersonMessage: number
  /** The dwarf's last recorded turn end (ADR-021 `TurnEnded`). */
  lastTurnEnd: Pick<TurnEnded, 'kind' | 'reliability' | 'at' | 'detail'> | null
  /** The dwarf's closing words of its last turn, for the tooltip. */
  closingWords?: string
  frontAsk: FrontAsk | null
  /** The answers-record's phase after a submit (US-MSG-011 AC03, AC04). */
  answers: 'submitted' | 'handed-over' | null
  /** A session the app only observes, with no end time to count idle time from (AC09). */
  observedWithoutEndTime: boolean
  /** The instant of the trigger. */
  at: Instant
}

/** 06 §9.2 `closingWords` "trimmed to 200 chars". */
export const CLOSING_WORDS_MAX = 200

export function deriveOutcomeLine(input: OutcomeInput): OutcomeLine {
  const { dwarfId, status, at } = input
  const runSteps = input.openRun?.stepCount ?? 0
  if (status === 'asking') {
    return {
      dwarfId,
      kind: 'waiting-on-you',
      stepCount: input.stepsSinceLastPersonMessage,
      parts: askParts(input.frontAsk),
      reliability: 'reliable',
      at
    }
  }
  if (status === 'working') {
    return {
      dwarfId,
      kind: 'working',
      stepCount: input.stepsSinceLastPersonMessage,
      parts: workingParts(input.answers, runSteps),
      reliability: 'reliable',
      at
    }
  }
  const steps = input.stepsSinceLastPersonMessage
  const stepParts: OutcomeLinePart[] = steps >= 1 ? [{ kind: 'steps', n: steps }] : []
  const end = input.lastTurnEnd
  if (end === null || end.reliability === 'inferred') {
    return {
      dwarfId,
      kind: 'working',
      stepCount: steps,
      parts: stepParts,
      reliability: 'inferred',
      at: end?.at ?? at
    }
  }
  const idle: OutcomeLinePart[] = input.observedWithoutEndTime
    ? []
    : [{ kind: 'idle-since', at: end.at }]
  const closing =
    end.kind === 'concluded' && input.closingWords !== undefined
      ? { closingWords: trimClosingWords(input.closingWords) }
      : {}
  return {
    dwarfId,
    kind: end.kind,
    stepCount: steps,
    parts: [...stepParts, ...idle],
    ...(end.detail === undefined ? {} : { detail: end.detail }),
    ...closing,
    reliability: 'reliable',
    at: end.at
  }
}

function askParts(ask: FrontAsk | null): OutcomeLinePart[] {
  if (ask === null) return []
  if (ask.kind === 'permission') return [{ kind: 'waiting-permission' }]
  return ask.questionCount >= 1 ? [{ kind: 'waiting-questions', n: ask.questionCount }] : []
}

function workingParts(answers: OutcomeInput['answers'], runSteps: number): OutcomeLinePart[] {
  if (answers === 'handed-over') return [{ kind: 'reading-your-message' }]
  if (answers === 'submitted') return [{ kind: 'answers-received' }]
  return runSteps >= 1 ? [{ kind: 'steps-so-far', n: runSteps }] : []
}

/** At most 200 UTF-16 units, never ending on half a surrogate pair. */
function trimClosingWords(text: string): string {
  if (text.length <= CLOSING_WORDS_MAX) return text
  const cut = text.slice(0, CLOSING_WORDS_MAX)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}
