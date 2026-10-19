// `ConversationCommands.recordSessionEnd` (16 §4.6; AMENDMENT-10, OQ-78; A10-01): the route of
// `DwarfDeparted` and `DriverSessionExited` (05 §4; routed by later: ISSUE-120). In ONE transaction
// (joined when the caller has one open, 16 §2.2) it closes the dwarf's open activity run at `at`
// (07 S11.05). A dwarf with no open run is a no-op, so the two events of one session end, or a
// replay, close it once (idempotent per dwarf). Only after the commit (08 §5.1; 16 §2.3), and only
// when a run closed, is its `ActivityChanged` published, or held for the caller whose transaction
// it joined. A closed run recomputes the outcome line in the same transaction with the status the
// previous line carries (ISSUE-102; 16 §4.6 amendment B), and its `OutcomeLineChanged` follows
// when the line changed (a working line loses its steps-so-far part).
import type { DwarfId, HostEpoch, Instant } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import { applySessionEnded } from '../domain/activityRun'
import type { ConversationEvent } from '../domain/events'
import type { ActivityLog } from '../ports/activityLog'
import { activityChanged } from './activityChanged'
import { outcomeLineChanged, recomputeOutcome } from './outcomeRecompute'
import type { ConversationCommands } from './ingest'

export interface SessionEndRecorderDeps {
  /** The dwarf's activity runs (16 §4.6 `ActivityLog`, amended with `openRun`). */
  activity: ActivityLog
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

export class SessionEndRecorder implements Pick<ConversationCommands, 'recordSessionEnd'> {
  constructor(private readonly deps: SessionEndRecorderDeps) {}

  recordSessionEnd(dwarfId: DwarfId, at: Instant): void {
    const { activity, transactions, scope, emit, clock, ids, hostEpoch } = this.deps
    const joined = scope.isInTransaction()
    const { closed, outcome } = transactions.inTransaction(() => {
      const change = applySessionEnded(activity.openRun(dwarfId), at)
      if (!change.changed || change.run === null) return { closed: null, outcome: null }
      activity.saveDisclosure(change.run)
      const line = recomputeOutcome(activity, dwarfId, (previous) => previous, clock.now())
      return { closed: change.run, outcome: line }
    })
    if (closed !== null) emit(activityChanged(closed, { clock, ids, hostEpoch }), joined)
    if (outcome !== null) emit(outcomeLineChanged(outcome, { clock, ids, hostEpoch }), joined)
  }
}
