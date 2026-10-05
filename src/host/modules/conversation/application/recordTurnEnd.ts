// `ConversationCommands.recordTurnEnd` (16 §4.6; AMENDMENT-10, OQ-78): the route of every reported
// turn end, a driver `turn.ended` (`DriverTurnEnded`) or an `ObservedTurnEnded` (05 §4, 08 §4).
//
// - In ONE transaction (joined when the caller has one open, 16 §2.2) it records the kernel
//   `LifecycleFactLog` fact `TurnEnded`, keyed `turn:<dwarfId>:<turnKey>` whatever path reported it
//   (ADR-021 item 3; 09 §5.6), so a driver report and a transcript read of the same end, or a replay
//   after a Host restart, are one fact.
// - Only for a `'new'` fact, and only after the commit (08 §5.1; 16 §2.3), it publishes the one
//   `TurnEnded` the other routes consume (crew, attention, the `turn.ended` frame). A `'duplicate'`
//   changes nothing and publishes nothing: the first report of a turn is the one that stands.
// - The end is recorded as reported: the route caps its reliability by the session's capability
//   first (`downgrade`, domain/turnEnd.ts; ADR-021 item 2). Conversation never infers an end from
//   silence (that is the observers', ADR-032 item 5) and never turns an end into a message (15 §1.2).
//
// - A new end closes the dwarf's open activity run in the same transaction (07 S11.04, reliable
//   or inferred, any kind; ISSUE-101), and its `ActivityChanged` follows the `TurnEnded` after the
//   commit. A duplicate closes nothing. The outcome line a new end changes joins with its issue
//   (later: ISSUE-102).
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { LifecycleFactLog } from '../../../kernel/ports/lifecycleFactLog'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import { applyTurnEnded, type ActivityDisclosure } from '../domain/activityRun'
import type { ConversationEvent } from '../domain/events'
import type { ActivityLog, ActivityRunReader } from '../ports/activityLog'
import { activityChanged } from './activityChanged'
import type { ConversationCommands } from './ingest'

export interface TurnEndRecorderDeps {
  /** The kernel log of `dwarf_lifecycle_facts`, shared with crew (16 §3). */
  facts: LifecycleFactLog
  /** The dwarf's activity runs (16 §4.6 `ActivityLog`, with the open-run read). */
  activity: ActivityLog & ActivityRunReader
  /** One transaction per report (16 §2.2), joined when the caller has one open. */
  transactions: TransactionRunner
  /** Whether the caller has a transaction open (16 §2.3). */
  scope: TransactionScope
  /** After the commit: publishes the event, or holds it for the caller whose transaction it joined. */
  emit: (event: ConversationEvent, joined: boolean) => void
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
}

export class TurnEndRecorder implements Pick<ConversationCommands, 'recordTurnEnd'> {
  constructor(private readonly deps: TurnEndRecorderDeps) {}

  recordTurnEnd(end: TurnEnded): void {
    const { facts, activity, transactions, scope, emit, clock, ids, hostEpoch } = this.deps
    const joined = scope.isInTransaction()
    const { recorded, closed } = transactions.inTransaction(() => {
      const outcome = facts.record({
        type: 'TurnEnded',
        dwarfId: end.dwarfId,
        turnKey: end.turnKey,
        occurredAt: end.at
      })
      if (outcome === 'duplicate') return { recorded: outcome, closed: null }
      const change = applyTurnEnded(activity.openRun(end.dwarfId), end.at)
      const run: ActivityDisclosure | null = change.changed ? change.run : null
      if (run !== null) activity.saveDisclosure(run)
      return { recorded: outcome, closed: run }
    })
    if (recorded === 'duplicate') return
    emit(
      {
        type: 'TurnEnded',
        v: 1,
        id: ids.uuidv7() as EventId,
        at: clock.now(),
        hostEpoch,
        payload: { dwarfId: end.dwarfId, end: { ...end } }
      },
      joined
    )
    if (closed !== null) emit(activityChanged(closed, { clock, ids, hostEpoch }), joined)
  }
}
