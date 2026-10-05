// `ConversationCommands.noteAsk` (16 §4.6; AMENDMENT-10; amended B2, owner 2026-10-05): the route of
// `ask.opened` / `ask.closed` (05 §4; routed by later: ISSUE-120), the outcome line's ask trigger
// (US-MSG-011 AC02). In ONE transaction (joined when the caller has one open, 16 §2.2) it reads the
// dwarf's previous line, derives the new one and saves it; after the commit it publishes
// `OutcomeLineChanged` only when the line changed, so the same `(askId, state)` twice changes
// nothing. The answers-record triggers stay `AnswerRecords.write` / `settle` (later: ISSUE-128).
//
// - `opened`: the dwarf is asking (07 S1.10–S1.12), with the ask's kind and question count.
// - `closed`: working while a run is open; otherwise idle on the previous end the line carries
//   (ADR-032: ask closed, no active turn → idle). Crew is never read: its status moves on its own
//   route.
import type { DwarfId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ConversationEvent } from '../domain/events'
import type { ActivityLog } from '../ports/activityLog'
import type { AskChange, ConversationCommands } from './ingest'
import { outcomeLineChanged, recomputeOutcome } from './outcomeRecompute'

export interface AskNoterDeps {
  activity: ActivityLog
  /** One transaction per change (16 §2.2), joined when the caller has one open. */
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

export class AskNoter implements Pick<ConversationCommands, 'noteAsk'> {
  constructor(private readonly deps: AskNoterDeps) {}

  noteAsk(dwarfId: DwarfId, change: AskChange): void {
    const { activity, transactions, scope, emit, clock, ids, hostEpoch } = this.deps
    const joined = scope.isInTransaction()
    const outcome = transactions.inTransaction(() => {
      const runOpen = activity.openRun(dwarfId) !== null
      return recomputeOutcome(
        activity,
        dwarfId,
        (previous) => {
          if (change.state === 'opened') {
            return {
              status: 'asking',
              stepsSinceLastPersonMessage: previous?.stepsSinceLastPersonMessage ?? 0,
              lastTurnEnd: previous?.lastTurnEnd ?? null,
              frontAsk:
                change.kind === 'permission'
                  ? { kind: 'permission' }
                  : { kind: 'question', questionCount: change.questionCount }
            }
          }
          if (previous === null) return null
          return { ...previous, status: runOpen ? 'working' : 'idle', frontAsk: null }
        },
        clock.now()
      )
    })
    if (outcome !== null) emit(outcomeLineChanged(outcome, { clock, ids, hostEpoch }), joined)
  }
}
