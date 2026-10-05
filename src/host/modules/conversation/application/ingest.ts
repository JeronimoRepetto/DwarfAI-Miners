// `ConversationCommands.ingest` (16 §4.6; 09 §5.2): one batch of entries from a live stream or a
// transcript reader is written in ONE transaction through `MessageLog.append` (steps 1–2), then
// `MessageLog.trim` caps the dwarf at `MESSAGES_PER_DWARF` rows in the same transaction (step 3,
// INV-61), then the batch's tool steps are folded into the dwarf's activity runs (07 §11) and saved
// through `ActivityLog`, which keeps the newest 50 runs, never the open one (step 4; ISSUE-101).
// Only after the commit (step 6; 08 §5.1) are `MessagesAppended` — with the rows this batch
// inserted and nothing else — and one `ActivityChanged` per run the batch changed, with its final
// state, published: a batch whose every key was already claimed publishes nothing, and a batch that
// throws rolls back every row and run and publishes nothing.
//
// Activity runs (07 §11; INV-66): only an entry this batch inserted moves a run, so a re-parse —
// the other path, or a replay after a restart — never grows a step count again (ADR-006: the
// entry's key was claimed). Per entry, in batch order: the dwarf speaking (a `dwarf` entry with
// text) closes the open run (S11.03); the person's own message keeps it open (S11.02); then each of
// the entry's tool steps opens a run or grows the open one (S11.01, S11.02). Package gap resolved
// in development: 15 §1.2 does not order an entry's text against its folded steps; a provider
// record says its words before the tool calls it makes, so the text applies first.
//
// An observed batch (ISSUE-099; AMENDMENT-10, OQ-78) arrives through observation's
// `ObservedBatchSink`, inside observation's batch transaction, so that the stream's cursor commits
// with the rows the batch produced (09 §5.2 step 5). Called while a transaction is open, `ingest`
// joins it (16 §2.2) and holds its events instead of publishing inside it (16 §2.3): the caller
// publishes the held events after its commit (`publishJoined`) or drops them after a rollback
// (`discardJoined`). The dwarf is the one the caller resolved, also for an entry a subagent wrote
// in its parent's session (`providerAgentId`, 15 §1.5): it is never re-resolved here.
//
// Amendment of 2026-10-02 to 16 §4.6 (ISSUE-098): `ingest` takes the feed of the batch (`origin`).
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { EventId, DwarfId, HostEpoch, Instant } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ConversationEntry } from '../../suppliers'
import {
  applyDwarfSpoke,
  applyPersonMessage,
  applyStep,
  type ActivityDisclosure,
  type RunChange
} from '../domain/activityRun'
import type { ConversationEvent } from '../domain/events'
import { toMessageView } from '../domain/messages'
import { MESSAGES_PER_DWARF } from '../domain/retention'
import type { ActivityLog } from '../ports/activityLog'
import type { MessageLog } from '../ports/messageLog'
import { activityChanged } from './activityChanged'

/**
 * The members of 05 §3.6 `ConversationCommands` built so far. Each later issue adds its member
 * with the types it needs (`send` / `retry` ISSUE-166, `noteAsk` ISSUE-102, …).
 */
export interface ConversationCommands {
  // from live streams + transcript readers
  ingest(dwarfId: DwarfId, entries: ConversationEntry[], origin: 'live-stream' | 'transcript'): void
  // ADR-021 payload from a driver turn.ended or ObservedTurnEnded; one transaction; LifecycleFactLog
  // key turn:<dwarfId>:<turnKey>; publishes TurnEnded only when the key is new (08 §4) (AMENDMENT-10)
  recordTurnEnd(end: TurnEnded): void
  // route of DwarfDeparted / DriverSessionExited: closes an open activity run (07 S11.05); idempotent (AMENDMENT-10)
  recordSessionEnd(dwarfId: DwarfId, at: Instant): void
}

export interface ConversationIngestDeps {
  log: MessageLog
  /** The dwarf's activity runs (16 §4.6 `ActivityLog`, amended with `openRun`). */
  activity: ActivityLog
  /** One transaction per batch (16 §2.2), joined when the caller has one open. */
  transactions: TransactionRunner
  /** Whether the caller has a transaction open (16 §2.3). */
  scope: TransactionScope
  /** Where the events go, after the commit (16 §2.3). */
  bus: DomainEventBus<ConversationEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
}

export class ConversationIngest implements Pick<ConversationCommands, 'ingest'> {
  /** The events of ingests that joined a caller's transaction, until it publishes or drops them. */
  private readonly held: ConversationEvent[] = []

  constructor(private readonly deps: ConversationIngestDeps) {}

  ingest(
    dwarfId: DwarfId,
    entries: ConversationEntry[],
    origin: 'live-stream' | 'transcript'
  ): void {
    const { log, transactions, scope, clock, ids, hostEpoch } = this.deps
    const joined = scope.isInTransaction()
    // A batch carries one dwarf's entries, so that dwarf is the only one it can push over the cap.
    const { appended, runs } = transactions.inTransaction(() => {
      const result = log.append(dwarfId, entries, origin)
      log.trim(dwarfId, MESSAGES_PER_DWARF)
      const changed = this.foldActivity(
        dwarfId,
        entries,
        result.appended.map((m) => m.sourceKey)
      )
      return { appended: result.appended, runs: changed }
    })
    if (appended.length > 0) {
      this.emit(
        {
          type: 'MessagesAppended',
          v: 1,
          id: ids.uuidv7() as EventId,
          at: clock.now(),
          hostEpoch,
          payload: { dwarfId, messages: appended.map(toMessageView) }
        },
        joined
      )
    }
    for (const run of runs) this.emit(activityChanged(run, { clock, ids, hostEpoch }), joined)
  }

  /**
   * After the commit of the transaction that wrote `event`'s rows: published now, or held for the
   * caller whose transaction the write joined (`publishJoined` / `discardJoined`).
   */
  emit(event: ConversationEvent, joined: boolean): void {
    if (joined) {
      this.held.push(event)
      return
    }
    this.deps.bus.publish(event)
  }

  /** After the caller's commit: publishes the events its joined ingests held, in order. */
  publishJoined(): void {
    for (const event of this.held.splice(0)) this.deps.bus.publish(event)
  }

  /** After the caller's rollback: the held events describe rows that no longer exist. */
  discardJoined(): void {
    this.held.length = 0
  }

  /**
   * Inside the batch transaction: applies the inserted entries to the dwarf's open run (07 §11) and
   * saves every run they changed, in the order each first changed, so a run that closed is saved
   * before the one that opened after it (INV-66). Returns those runs in their final state.
   */
  private foldActivity(
    dwarfId: DwarfId,
    entries: readonly ConversationEntry[],
    insertedKeys: readonly (string | null)[]
  ): ActivityDisclosure[] {
    const { activity, clock, ids } = this.deps
    const inserted = new Set(insertedKeys)
    const changed = new Map<string, ActivityDisclosure>()
    const now = clock.now()
    let open = activity.openRun(dwarfId)
    const take = (change: RunChange): void => {
      if (!change.changed || change.run === null) return
      changed.set(change.run.id, change.run)
      open = change.run.open ? change.run : null
    }
    for (const entry of entries) {
      // Only an entry this batch inserted, once: a claimed key is a re-parse (ADR-006).
      if (!inserted.delete(entry.sourceKey)) continue
      const at = entry.providerTime ?? now
      if (entry.role === 'dwarf' && entry.text.trim() !== '') take(applyDwarfSpoke(open, at))
      if (entry.role === 'person') take(applyPersonMessage(open, at))
      for (const step of entry.activity ?? []) {
        take(
          applyStep(
            open,
            dwarfId,
            { sourceKey: step.sourceKey, summary: step.summary, at: step.at ?? at },
            () => ids.uuidv7()
          )
        )
      }
    }
    for (const run of changed.values()) activity.saveDisclosure(run)
    return [...changed.values()]
  }
}
