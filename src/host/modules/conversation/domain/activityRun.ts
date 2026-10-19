// Machine 11, the activity run (07 §11): the folded unit of a turn's tool steps, "Working…" while
// open and "<n> step[s] · activity" once closed, as the aggregate `ActivityDisclosure` (06 §9.2).
// Pure: no I/O, no clock read, no id minting (05 §2.2, R1): every instant and the id of a new run
// are passed in.
//
// - A run opens at the first tool step when the dwarf has no open run (S11.01), with stepCount 1.
// - It grows in place on every further step (S11.02). The person's own message (delivered or
//   failed), an ask and its "Answers:" record keep it open and change nothing (S11.02, INV-66).
// - It closes when the dwarf speaks (S11.03), its turn ends (S11.04, reliable or inferred), its
//   session ends (S11.05) or the Host lost it in a crash (S11.06, at the crash-time inferred end).
// - A re-adopted running turn and a window close are no transition (S11.07).
// - A closed run is terminal: a later step opens a new run. With no open run there is nothing to
//   close or keep open, so every trigger but a tool step is no transition (`machine11` → null).
//
// The run's `turnKey` (09 §4.4 `turn_key`, UNIQUE per dwarf) is the `sourceKey` of the step that
// opened it. Package gap resolved in development: 10 calls the column "provider turn the run
// belongs to", but a turn can hold several runs (the dwarf speaks mid-turn, S11.03, and a later
// step of the same turn opens a new run, S11.01; US-MSG-014.AC04), so the provider turn id alone
// would collide on that UNIQUE. A step's `sourceKey` is unique on every path (15 §1.5) and lives in
// the same key space as `TurnEnded.turnKey`, so one run per opening step is unique and stable.
import type { DwarfId, Instant } from '../../../kernel/domain/values'

/** 06 §9.2 `ActivityDisclosure`. `expanded` is renderer state and is not here. */
export interface ActivityDisclosure {
  id: string
  dwarfId: DwarfId
  turnKey: string
  open: boolean
  stepCount: number
  /** One line per step; never tool output (ADR-007 item 4). */
  summaries: string[]
  openedAt: Instant
  closedAt?: Instant
}

/** Where the dwarf's run stands: no open run (`[*]`), an open one, or a closed one. */
export type RunState = 'none' | 'open' | 'closed'

/** The triggers of 07 §11. */
export type ActivityTrigger =
  | 'tool-step'
  | 'person-message'
  | 'ask-opened'
  | 'answer-record'
  | 'dwarf-spoke'
  | 'turn-ended'
  | 'session-ended'
  | 'boot-lost'
  | 'boot-readopted'
  | 'window-closed'

export interface Machine11Transition {
  id: 'S11.01' | 'S11.02' | 'S11.03' | 'S11.04' | 'S11.05' | 'S11.06' | 'S11.07'
  from: 'none' | 'open'
  trigger: ActivityTrigger
  to: 'open' | 'closed'
}

const row = (
  id: Machine11Transition['id'],
  from: Machine11Transition['from'],
  trigger: ActivityTrigger,
  to: Machine11Transition['to']
): Machine11Transition => ({ id, from, trigger, to })

/** 07 §11, row by row: the only transitions machine 11 has. */
export const MACHINE_11: readonly Machine11Transition[] = [
  row('S11.01', 'none', 'tool-step', 'open'),
  row('S11.02', 'open', 'tool-step', 'open'),
  row('S11.02', 'open', 'person-message', 'open'),
  row('S11.02', 'open', 'ask-opened', 'open'),
  row('S11.02', 'open', 'answer-record', 'open'),
  row('S11.03', 'open', 'dwarf-spoke', 'closed'),
  row('S11.04', 'open', 'turn-ended', 'closed'),
  row('S11.05', 'open', 'session-ended', 'closed'),
  row('S11.06', 'open', 'boot-lost', 'closed'),
  row('S11.07', 'open', 'boot-readopted', 'open'),
  row('S11.07', 'open', 'window-closed', 'open')
]

/** The 07 §11 transition a trigger takes from `from`, or null when 07 lists none. */
export function machine11(from: RunState, trigger: ActivityTrigger): Machine11Transition | null {
  return MACHINE_11.find((t) => t.from === from && t.trigger === trigger) ?? null
}

/** The run after a trigger, and whether an `ActivityChanged` is due (08 §2.6). */
export interface RunChange {
  run: ActivityDisclosure | null
  changed: boolean
}

/** The fields of a 15 §1.2 `ActivityStep` a run keeps, with its instant resolved by the caller. */
export interface ActivityStepInput {
  sourceKey: string
  summary: string
  at: Instant
}

function stateOf(run: ActivityDisclosure | null): RunState {
  if (run === null) return 'none'
  return run.open ? 'open' : 'closed'
}

const unchanged = (run: ActivityDisclosure | null): RunChange => ({ run, changed: false })

/** S11.01 / S11.02: a tool step opens a run, or grows the open one in place. */
export function applyStep(
  run: ActivityDisclosure | null,
  dwarfId: DwarfId,
  step: ActivityStepInput,
  newId: () => string
): RunChange {
  if (stateOf(run) === 'open' && run !== null) {
    return {
      run: { ...run, stepCount: run.stepCount + 1, summaries: [...run.summaries, step.summary] },
      changed: true
    }
  }
  // No open run, or a closed one (terminal): a new run from `[*]`.
  return {
    run: {
      id: newId(),
      dwarfId,
      turnKey: step.sourceKey,
      open: true,
      stepCount: 1,
      summaries: [step.summary],
      openedAt: step.at
    },
    changed: true
  }
}

/**
 * A trigger that keeps an open run as it is (S11.02 without a step, S11.07); with no open run 07
 * lists no transition for it, so it changes nothing either way.
 */
const keep = (run: ActivityDisclosure | null): RunChange => unchanged(run)

/** A trigger that closes the open run at `at` (S11.03–S11.06); nothing to close is no change. */
function close(
  trigger: ActivityTrigger
): (run: ActivityDisclosure | null, at: Instant) => RunChange {
  return (run, at) => {
    if (run === null || machine11(stateOf(run), trigger)?.to !== 'closed') return unchanged(run)
    return { run: { ...run, open: false, closedAt: at }, changed: true }
  }
}

/** S11.02: the person's own message, delivered or failed, never closes the run (INV-66). */
export function applyPersonMessage(run: ActivityDisclosure | null, at: Instant): RunChange {
  void at
  return keep(run)
}

/** S11.02: an ask keeps the run open (US-ASK-006.AC03). */
export const applyAskOpened = keep
/** S11.02: the "Answers:" record keeps the run open (US-MSG-014.AC05). */
export const applyAnswerRecord = keep
/** S11.07: a re-adopted server session with its turn still running. */
export const applyReadopted = keep
/** S11.07: a window close. */
export const applyWindowClosed = keep

/** S11.03: the dwarf speaks. */
export const applyDwarfSpoke = close('dwarf-spoke')
/** S11.04: `TurnEnded`, reliable or inferred, any kind. */
export const applyTurnEnded = close('turn-ended')
/** S11.05: `DwarfDeparted` / `DriverSessionExited`. */
export const applySessionEnded = close('session-ended')
/** S11.06: at boot, the dwarf is unrecovered or `turn-lost`; `at` is the crash-time inferred end. */
export const applyBootLost = close('boot-lost')
