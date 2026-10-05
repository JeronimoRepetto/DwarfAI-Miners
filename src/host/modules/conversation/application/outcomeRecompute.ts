// The outcome line's recompute (ISSUE-102; 16 §4.6 amendment B), shared by `ingest`,
// `recordTurnEnd`, `recordSessionEnd` and `noteAsk`. Inside the command's transaction it reads the
// dwarf's previous line (`outcomeOf`), lets the trigger say what changed, derives the new line
// (`deriveOutcomeLine`, domain/outcomeLine.ts) and saves it (`saveOutcome`). It returns the line only
// when it changed, so the command publishes `OutcomeLineChanged` after its commit for a change and
// for nothing else (08 §5.1).
//
// The line is its own memory: the status, the last turn end, the front ask and the running step
// total since the person's last message are read back from the previous line, never from crew,
// whose status moves only after `TurnEnded` is published (05 §4). A line of a turn in progress keys
// its `at` on the trigger, so two derivations that differ only in that instant are the same line.
//
// Not built here (lead items): the answers-record phase comes with `AnswerRecords.write` / `settle`
// (later: ISSUE-128), and no source says yet that a session is observed with no end time; both are
// passed as absent (`answers: null`, `observedWithoutEndTime: false`). A previous waiting-on-you
// line carries no turn end, so an ask that closes with no run open leaves the dwarf idle with no
// reliable end to word (the line's open design item, FUNCTIONAL-SPEC §9).
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, EventId, Instant } from '../../../kernel/domain/values'
import type { OutcomeLineChanged } from '../domain/events'
import {
  deriveOutcomeLine,
  type FrontAsk,
  type OutcomeLine,
  type OutcomeStatus
} from '../domain/outcomeLine'
import type { ActivityLog } from '../ports/activityLog'
import type { EventStamp } from './activityChanged'

/** What a line remembers of the dwarf, and what a trigger changes. */
export interface OutcomeContext {
  status: OutcomeStatus
  stepsSinceLastPersonMessage: number
  lastTurnEnd: Pick<TurnEnded, 'kind' | 'reliability' | 'at' | 'detail'> | null
  frontAsk: FrontAsk | null
  closingWords?: string
}

/**
 * In the caller's transaction: the new line saved, or null when the trigger makes no line (`next`
 * returns null) or the derived line equals the stored one.
 */
export function recomputeOutcome(
  activity: ActivityLog,
  dwarfId: DwarfId,
  next: (previous: OutcomeContext | null) => OutcomeContext | null,
  at: Instant
): OutcomeLine | null {
  const previous = activity.outcomeOf(dwarfId)
  const context = next(previous === null ? null : contextOf(previous))
  if (context === null) return null
  const line = deriveOutcomeLine({
    dwarfId,
    ...context,
    openRun: activity.openRun(dwarfId),
    answers: null, // later: ISSUE-128 (AnswerRecords)
    observedWithoutEndTime: false, // no source yet (lead item)
    at
  })
  if (previous !== null && sameLine(previous, line)) return null
  activity.saveOutcome(line)
  return line
}

/** The context a stored line carries (the inverse of the rule, for what the rule keeps). */
export function contextOf(line: OutcomeLine): OutcomeContext {
  const steps = line.stepCount
  if (line.kind === 'waiting-on-you') {
    return {
      status: 'asking',
      stepsSinceLastPersonMessage: steps,
      lastTurnEnd: null,
      frontAsk: frontAskOf(line)
    }
  }
  if (line.kind === 'working') {
    if (line.reliability === 'reliable') {
      return {
        status: 'working',
        stepsSinceLastPersonMessage: steps,
        lastTurnEnd: null,
        frontAsk: null
      }
    }
    // Idle with no reliable end: an inferred end's kind is never shown (ADR-021 item 3), so the
    // line keeps only its instant.
    return {
      status: 'idle',
      stepsSinceLastPersonMessage: steps,
      lastTurnEnd: { kind: 'concluded', reliability: 'inferred', at: line.at },
      frontAsk: null
    }
  }
  return {
    status: 'idle',
    stepsSinceLastPersonMessage: steps,
    lastTurnEnd: {
      kind: line.kind,
      reliability: 'reliable',
      at: line.at,
      ...(line.detail === undefined ? {} : { detail: line.detail })
    },
    frontAsk: null,
    ...(line.closingWords === undefined ? {} : { closingWords: line.closingWords })
  }
}

function frontAskOf(line: OutcomeLine): FrontAsk | null {
  for (const part of line.parts) {
    if (part.kind === 'waiting-permission') return { kind: 'permission' }
    if (part.kind === 'waiting-questions') return { kind: 'question', questionCount: part.n }
  }
  return null
}

/** Equal lines; a line of a turn in progress does not change by the instant it was derived at. */
function sameLine(a: OutcomeLine, b: OutcomeLine): boolean {
  const inProgress = (l: OutcomeLine) => l.kind === 'working' || l.kind === 'waiting-on-you'
  return (
    a.dwarfId === b.dwarfId &&
    a.kind === b.kind &&
    a.stepCount === b.stepCount &&
    JSON.stringify(a.parts) === JSON.stringify(b.parts) &&
    a.detail === b.detail &&
    a.closingWords === b.closingWords &&
    a.reliability === b.reliability &&
    (a.at === b.at || (inProgress(a) && inProgress(b)))
  )
}

/** 08 §0 `OutcomeLineChanged` for a line a committed transaction changed. */
export function outcomeLineChanged(line: OutcomeLine, stamp: EventStamp): OutcomeLineChanged {
  return {
    type: 'OutcomeLineChanged',
    v: 1,
    id: stamp.ids.uuidv7() as EventId,
    at: stamp.clock.now(),
    hostEpoch: stamp.hostEpoch,
    payload: { dwarfId: line.dwarfId, outcome: line }
  }
}
