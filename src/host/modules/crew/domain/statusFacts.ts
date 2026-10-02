// Pure fact updates of machine 1 (07 §1; ADR-032 items 2–5). Each takes the dwarf's persisted
// `StatusFacts` and returns the next ones; the status itself is always `classifyDwarfStatus`.
import { ASLEEP_AFTER_MS, type StatusFacts } from './status'

/**
 * S1.01 / S1.02. `start` is `CrewCommands.arrive`'s `status` (05 §3.2): `'working'` when a first
 * message is pending (launch, delegation) or a turn is already in progress (rediscovery,
 * US-OBS-006); `'idle'` for an observed arrival in a known mine with no message yet (PO #14).
 */
export function arrivalFacts(at: number, start: 'working' | 'idle'): StatusFacts {
  return {
    processState: 'running',
    turn: start === 'working' ? { state: 'active' } : { state: 'none-yet', arrivedAt: at },
    lastActivityAt: at
  }
}

/** A turn end as the conversation module reports it (S1.03, S1.04; ADR-021 item 3). */
export interface TurnEnd {
  at: number
  reliability: 'reliable' | 'inferred'
  /** Interrupted from the app (Remove mine, "Stop dwarf…" mid-turn): ends the turn with no cue. */
  cancelledFromApp: boolean
}

/** An ask as the broker opens it (machine 6): an `auto-denied` request never sets `openAsk`. */
export interface AskOpening {
  kind: 'question' | 'permission'
  askedAt: number
  state: 'open' | 'auto-denied'
}

/** S1.08, S1.09: a turn start makes the dwarf `working` and is activity. */
export function turnStarted(f: StatusFacts, at: number): StatusFacts {
  return { ...f, turn: { state: 'active' }, lastActivityAt: Math.max(f.lastActivityAt, at) }
}

/** S1.03, S1.04, S1.19: a reliable or inferred end moves the status alike (ADR-032 item 5). */
export function turnEnded(f: StatusFacts, end: TurnEnd): StatusFacts {
  return { ...f, turn: { state: 'ended', endedAt: end.at, reliability: end.reliability } }
}

/** The S1.03 action guard: only a reliable end the app did not cancel fires the finished cue. */
export function firesFinishedCue(end: TurnEnd): boolean {
  return end.reliability === 'reliable' && !end.cancelledFromApp
}

/** S1.06, S1.07: activity that is not a turn start only moves `lastActivityAt` (never backwards). */
export function otherActivity(f: StatusFacts, at: number): StatusFacts {
  return { ...f, lastActivityAt: Math.max(f.lastActivityAt, at) }
}

/**
 * S1.10–S1.12, S1.16: a trusted ask makes any status `asking`; an `auto-denied` one changes
 * nothing. While an ask is already open, the front ask stays (the next one waits in the queue, S1.15).
 */
export function askOpened(f: StatusFacts, ask: AskOpening): StatusFacts {
  if (ask.state === 'auto-denied' || f.openAsk) return f
  return { ...f, openAsk: { kind: ask.kind, askedAt: ask.askedAt } }
}

/**
 * S1.13–S1.15: the front ask closed (any reason). `next` is the dwarf's next open ask, which
 * becomes the front one; without it the dwarf leaves `asking` for what its turn says.
 */
export function askClosed(
  f: StatusFacts,
  next?: { kind: 'question' | 'permission'; askedAt: number }
): StatusFacts {
  const rest: StatusFacts = {
    processState: f.processState,
    turn: f.turn,
    lastActivityAt: f.lastActivityAt
  }
  return next === undefined
    ? rest
    : { ...rest, openAsk: { kind: next.kind, askedAt: next.askedAt } }
}

/** S1.20: the process closed; the machine ends and no wake-up remains. */
export function departed(f: StatusFacts): StatusFacts {
  return { ...f, processState: 'closed' }
}

/**
 * The one wake-up of an idle dwarf (ADR-032 item 3): `max(idleSince, lastActivityAt) + 60 s`, or
 * null when nothing can move the status by time alone (asking, working, departed).
 */
export function nextWakeAt(f: StatusFacts): number | null {
  if (f.processState === 'closed' || f.openAsk || f.turn.state === 'active') return null
  const idleSince = f.turn.state === 'ended' ? f.turn.endedAt : f.turn.arrivedAt
  return Math.max(idleSince, f.lastActivityAt) + ASLEEP_AFTER_MS
}
