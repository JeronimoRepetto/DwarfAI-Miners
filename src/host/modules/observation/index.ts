// The observation module (05 §3.3): the Host notices sessions started outside DwarfAI. Its
// observation loop (ISSUE-070) polls every provider's `ObservationAdapter`, reads each stream from
// its forward-only cursor and turns the records into events, writing only its own tables
// (`source_cursors`, `observed_sessions`, `observed_session_streams`; INV-37): messages and usage
// go to conversation and ledger through the `ObservedBatchSink` bridge. The provider adapters
// (later: ISSUE-071…ISSUE-075), the ended-agent ledger (later: ISSUE-072) and `catchUp` (later:
// ISSUE-078) join with their issues; `host/main.ts` composes it (later: ISSUE-095).
import type { ProcessIdentity } from '../../kernel/domain/processIdentity'
import type { DwarfId, HostEpoch } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { FileSystem } from '../../kernel/ports/fileSystem'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { SqliteCursorStore } from './adapters/SqliteCursorStore'
import { SqliteObservedSessionStore } from './adapters/SqliteObservedSessionStore'
import type { ObservationEvent } from './application/events'
import type { ObservationControlSoFar } from './application/observationControl'
import { ObservationLoop } from './application/observationLoop'
import { createObservationQueries, type ObservationQueries } from './application/observationQueries'
import type { CursorStore } from './ports/cursorStore'
import type { ObservationAdapter } from './ports/observationAdapter'
import type { ObservedBatchSink } from './ports/observedBatchSink'
import type { ObservedSessionStore } from './ports/observedSessionStore'

export type {
  ObservationEvent,
  SessionActivityObserved,
  SessionClosedObserved,
  SessionObserved,
  TranscriptEntriesObserved,
  UsageObserved
} from './application/events'
export type { ObservationControl, ObservationControlSoFar } from './application/observationControl'
export { OBSERVATION_POLL_MS, type NudgeHint } from './application/observationLoop'
export type { ObservationQueries } from './application/observationQueries'
export {
  observedTransition,
  type ObservedSessionState,
  type ObservedStep,
  type ObservedTransitionId,
  type ObservedTrigger
} from './domain/observedSession'
export type { CursorStore } from './ports/cursorStore'
export type {
  Cursor,
  CursorKind,
  ObservationAdapter,
  ObservedEvent,
  SourceFile
} from './ports/observationAdapter'
export type { ObservedBatchSink } from './ports/observedBatchSink'
export type {
  ObservedSession,
  ObservedSessionRef,
  ObservedSessionStore,
  ObservedSessionStream
} from './ports/observedSessionStore'
export type { TranscriptEntry, TranscriptReader } from './ports/transcriptReader'

export interface ObservationDeps {
  /** One per provider (05 §3.3), in the order the loop reads them. */
  adapters: readonly ObservationAdapter[]
  fs: FileSystem
  cursors: CursorStore
  sessions: ObservedSessionStore
  /** The `host/wiring` bridge to conversation and ledger (AMENDMENT-10). */
  sink: ObservedBatchSink
  /** The Host's transaction runner (16 §2.2). */
  transactions: TransactionRunner
  /** Where the module publishes its events after commit (16 §2.3). */
  bus: DomainEventBus<ObservationEvent>
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /** Defaults to `OBSERVATION_POLL_MS`. */
  pollMs?: number
}

/**
 * The process identity (pid + start time + boot id) an observation adapter recorded for an
 * observed session's provider process (ADR-014 item 2; 15 §5 "Ending observed sessions without a
 * process identity"), read by the `SessionTerminator` bridge (05 §4 item 1). Read only; `null`
 * when none was recorded. Package gap: 16 §4.3 names no read for it; this is the read 05 §4
 * item 1 needs, kept off the frozen `ObservationQueries`.
 */
export interface ObservedProcessIdentities {
  processIdentityOf(dwarfId: DwarfId): ProcessIdentity | null
}

export interface Observation {
  control: ObservationControlSoFar
  queries: ObservationQueries
  /**
   * No adapter of this build records a process identity: Codex, Antigravity and OpenCode files
   * carry no pid and spike S-014-1 is `partial` (its default: `no-identity`), and the Claude
   * adapter, which reads the registry pid and start time, is not built yet (later: ISSUE-071,
   * ISSUE-072). So every observed session answers `null` and ends `failed: 'no-identity'`.
   */
  processIdentities: ObservedProcessIdentities
  /** Resolves once no observation cycle is in flight (tests and an orderly shutdown). */
  whenIdle(): Promise<void>
}

/** The module over its ports. */
export function createObservation(deps: ObservationDeps): Observation {
  const loop = new ObservationLoop(deps)
  return {
    control: {
      start: () => loop.start(),
      stop: () => loop.stop(),
      nudge: (hint) => loop.nudge(hint)
    },
    queries: createObservationQueries({ sessions: deps.sessions }),
    processIdentities: { processIdentityOf: () => null },
    whenIdle: () => loop.whenIdle()
  }
}

/** The module's two stores over the Host database (09 §4.2). */
export function createSqliteObservationStores(deps: {
  db: SqliteDatabase
  scope: TransactionScope
  clock: Clock
}): { cursors: CursorStore; sessions: ObservedSessionStore } {
  return {
    cursors: new SqliteCursorStore({ db: deps.db, scope: deps.scope, clock: deps.clock }),
    sessions: new SqliteObservedSessionStore({ db: deps.db, scope: deps.scope })
  }
}
