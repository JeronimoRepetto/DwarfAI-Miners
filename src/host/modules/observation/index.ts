// The observation module (05 §3.3): the Host notices sessions started outside DwarfAI. Its
// observation loop (ISSUE-070) polls every provider's `ObservationAdapter`, reads each stream from
// its forward-only cursor and turns the records into events, writing only its own tables
// (`source_cursors`, `observed_sessions`, `observed_session_streams`; INV-37): messages and usage
// go to conversation and ledger through the `ObservedBatchSink` bridge. The Claude (ISSUE-071) and
// Codex (ISSUE-073) adapters are exported for the composition; the other provider adapters (later:
// ISSUE-074, ISSUE-075) and `catchUp` (later: ISSUE-078) join with their issues; `host/main.ts`
// composes it (later: ISSUE-095). The `EndedAgentLedger` (`ended_agents`) keeps every identity
// DwarfAI ended or saw end from arriving again (ISSUE-072, INV-36), and the Claude adapter answers
// a session's process identity through its #45 guard (`processRegistries`).
import type { ProcessIdentity } from '../../kernel/domain/processIdentity'
import type { DwarfId, HostEpoch, ProviderIdentity } from '../../kernel/domain/values'
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
import { SqliteEndedAgentLedger } from './adapters/SqliteEndedAgentLedger'
import { SqliteObservedSessionStore } from './adapters/SqliteObservedSessionStore'
import type { ObservationEvent } from './application/events'
import type { ObservationControlSoFar } from './application/observationControl'
import { ObservationLoop } from './application/observationLoop'
import { createObservationQueries, type ObservationQueries } from './application/observationQueries'
import type { CursorStore } from './ports/cursorStore'
import type { ObservationAdapter } from './ports/observationAdapter'
import type { EndedAgentLedger } from './ports/endedAgentLedger'
import type { ObservedBatchSink } from './ports/observedBatchSink'
import type { ObservedSessionStore } from './ports/observedSessionStore'

export type {
  ObservationEvent,
  ObservedTurnEnded,
  SessionActivityObserved,
  SessionClosedObserved,
  SessionObserved,
  TranscriptEntriesObserved,
  UsageObserved
} from './application/events'
export type { ObservationControl, ObservationControlSoFar } from './application/observationControl'
export {
  CLAUDE_OBSERVED_CAPABILITIES,
  ClaudeObservationAdapter,
  claudeConfigDirOf,
  type ClaudeObservationAdapterOptions
} from './adapters/claude/ClaudeObservationAdapter'
export {
  CODEX_OBSERVED_CAPABILITIES,
  CodexObservationAdapter,
  codexHomeOf,
  type CodexObservationAdapterOptions
} from './adapters/codex/CodexObservationAdapter'
export {
  OPENCODE_OBSERVED_CAPABILITIES,
  OpenCodeObservationAdapter,
  openCodeStoreRootOf,
  type OpenCodeLifetimeTotal,
  type OpenCodeLifetimeTotals,
  type OpenCodeObservationAdapterOptions
} from './adapters/opencode/OpenCodeObservationAdapter'
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
export type { EndedAgentLedger } from './ports/endedAgentLedger'
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
  /** The identities DwarfAI ended or saw end (16 §4.3; INV-36). */
  ended: EndedAgentLedger
  /**
   * The adapters that can name an observed session's process (the Claude adapter, through its
   * registry and #45 guard); none answers `null` for every dwarf.
   */
  processRegistries?: readonly ObservedProcessRegistry[]
}

/**
 * An adapter's read of the process identity of one observed session, or null when it has none
 * (a subagent, a session no registry names, a pid the #45 guard did not take). Internal to the
 * module: the read behind `ObservedProcessIdentities` (same package gap).
 */
export interface ObservedProcessRegistry {
  processIdentityOf(identity: ProviderIdentity): ProcessIdentity | null
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
   * Only the Claude adapter records a process identity: the registry pid and its recorded start,
   * taken through the #45 guard (ISSUE-072). Codex, Antigravity and OpenCode files carry no pid and
   * spike S-014-1 is `partial` (its default: `no-identity`), and a subagent has no process of its
   * own, so those answer `null` and end `failed: 'no-identity'`. A dwarf is known by the
   * identity of the last batch written to it this Host run: after a restart, a dwarf whose session
   * wrote nothing since answers `null` until it does.
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
      nudge: (hint) => loop.nudge(hint),
      recordEnded: (identity, at) => loop.recordEnded(identity, at)
    },
    queries: createObservationQueries({ sessions: deps.sessions }),
    processIdentities: {
      processIdentityOf: (dwarfId) => {
        const identity = loop.identityOf(dwarfId)
        if (identity === null) return null
        for (const registry of deps.processRegistries ?? []) {
          const found = registry.processIdentityOf(identity)
          if (found !== null) return found
        }
        return null
      }
    },
    whenIdle: () => loop.whenIdle()
  }
}

/** The module's three stores over the Host database (09 §4.2). */
export function createSqliteObservationStores(deps: {
  db: SqliteDatabase
  scope: TransactionScope
  clock: Clock
}): { cursors: CursorStore; sessions: ObservedSessionStore; ended: EndedAgentLedger } {
  return {
    cursors: new SqliteCursorStore({ db: deps.db, scope: deps.scope, clock: deps.clock }),
    sessions: new SqliteObservedSessionStore({ db: deps.db, scope: deps.scope }),
    ended: new SqliteEndedAgentLedger({ db: deps.db, scope: deps.scope })
  }
}
