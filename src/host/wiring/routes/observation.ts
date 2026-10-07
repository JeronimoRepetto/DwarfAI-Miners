// The observation module's wiring (05 §3.3, §4; 16 §8.2, §8.3), as routes/crew.ts and
// routes/mines.ts. Observation serves no seam-B member and no snapshot section, so it has no
// `serve` half:
//
// - `wireObservation`, run by boot step 4 before crew: `createObservation` over the Host database
//   (the module's three stores, built once by the composition root and shared with crew's
//   `ProviderIdentity → DwarfId` reads), the four provider adapters of 15 §5 (Claude, Codex,
//   Antigravity, OpenCode), each reading the provider's own folders under the person's home or the
//   environment override it honours (HO-09), never writing them, and the 05 §4 route of this module:
//   - `ProviderErrorObserved` → diagnostics: one `warn` record per event, its cause class, provider
//     and dwarf id only, never the provider's text (19 §6, §7; ADR-026 items 3–4). Its toast is the
//     board frames' (routes/mines.ts `publishBoardFrames`, 14 §2.4 B-F28), and its `checkFolder` is
//     the mines route's (AMENDMENT-2, SC-AR-04).
//   Crew's half of the binding (`CrewObservationBinding`: the process identities the Claude adapter
//   takes through its #45 guard, `recordEnded` for the `SessionTerminator` bridge and the index) is
//   `WiredObservation.crew`.
// - `start`, run by boot step 7 (16 §8.2) after recovery (step 5) and before `ready` (step 8):
//   `catchUp()` and then `start()`; the catch-up pass may go on after `ready` (16 §4.3), and the
//   live loop's first cycle runs after it. Every route that reads an observation event is
//   subscribed at step 4, before `catchUp` publishes its first event. It is `null` while the batch
//   sink is the placeholder: a cursor moved past a batch nothing stored would lose its messages and
//   usage for good (INV-98), so observation cannot start before the sink is real (since ISSUE-108
//   it is: `host/main.ts` passes it as step 7). It is `null` as well in a cut-1 rollback build, whose sink is
//   `observationWritesOff` (host/wiring/cut1Rollback.ts; 21 §2 cut 1 row "Rollback"): the legacy observer
//   is the one observer again, so the Host observer writes no cursor, session, usage or credit.
// - `nudge`, the hook ingress's entry point (05 §3.3; the ingress is EPIC-08's, later: ISSUE-133):
//   it only brings the next poll cycle forward.
//
// Composed only where the module exists, and why:
// - The `ObservedBatchSink` bridge (AMENDMENT-10; bridges/observedBatchSink.ts): its ledger half
//   (ISSUE-096) and its conversation half (ISSUE-108). Without the conversation half the bridge
//   hands this wiring `noObservedBatchSinkYet`, since a batch's messages would reach no module, and
//   with it the module is composed but never started. The bridge's runner publishes each half's
//   held events after each batch commit.
// - `TranscriptEntriesObserved` / `UsageObserved` / `ObservedTurnEnded` (05 §4): the batch's
//   entries reach conversation through the bridge; `ObservedTurnEnded` → `recordTurnEnd` is a
//   cut-1 route (routes/cut1Routes.ts, ISSUE-120); the ledger takes usage through the bridge, not through `UsageObserved` (05 §4).
// - No simulated observation adapter: the simulated provider's sessions are the suppliers'
//   `SimulatedDriver` (15 §4.12), and 15 §5 lists four observed providers.
import type { HostEpoch, ProviderId } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { FileSystem } from '../../kernel/ports/fileSystem'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { ProcessControl } from '../../kernel/ports/processControl'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import {
  AntigravityObservationAdapter,
  ClaudeObservationAdapter,
  CODEX_PROCESS_STEMS,
  CodexObservationAdapter,
  OPENCODE_PROCESS_STEMS,
  OpenCodeObservationAdapter,
  ProcessGoneWatch,
  SharedProcessListing,
  antigravityGeminiDirOf,
  claudeConfigDirOf,
  codexHomeOf,
  createObservation,
  openCodeStoreRootOf,
  type CursorStore,
  type EndedAgentLedger,
  type NudgeHint,
  type Observation,
  type ObservationAdapter,
  type ObservationEvent,
  type ObservedBatchSink,
  type ObservedProcessRegistry,
  type ObservedSessionStore
} from '../../modules/observation'
import type { ReadOnlySnapshotOpener } from '../../platform/sqlite/readOnlySnapshot'
import { errorCode } from '../boot'
import type { CrewObservationBinding } from './crew'

/** The diagnostics event of an observed provider error (19 §9.4 `observation.*` events, ADR-026). */
export const PROVIDER_ERROR_EVENT = 'observation.provider-error'

/**
 * The batch sink of a bridge without its conversation half: the bridge hands it out then. A module
 * wired with it never starts (`WiredObservation.start` is `null`).
 */
export const noObservedBatchSinkYet: ObservedBatchSink = { apply: () => undefined }

/**
 * The batch sink of a cut-1 rollback build (21 §2 cut 1 row "Rollback"; `cut1Rollback.ts`): the legacy observer is
 * the one observer again, so the Host observer writes nothing. A module wired with it is composed (crew's identity
 * reads keep the rows the Host wrote before) but never started (`WiredObservation.start` is `null`), whatever the
 * bridge's halves are.
 */
export const observationWritesOff: ObservedBatchSink = { apply: () => undefined }

/**
 * Whether a module wired with `sink` may run: false for `noObservedBatchSinkYet` and `observationWritesOff`. The one
 * gate of every path that writes what observation feeds: step 7's `start`, the coal backfill
 * (`startBackfillWhenObserving`) and the per-mine backfill of O-11-10 (`routeMineBackfillWhenObserving`).
 */
export function observesWith(sink: ObservedBatchSink): boolean {
  return sink !== noObservedBatchSinkYet && sink !== observationWritesOff
}

/** Where each observed provider keeps its data (15 §5 "Sources"), resolved once at Host start. */
export interface ObservedProviderFolders {
  /** `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeConfigDir: string
  /** `CODEX_HOME`, else `~/.codex`. */
  codexHome: string
  /** `~/.gemini`, the folder of the three Antigravity trees. */
  geminiDir: string
  /** `~/.local/share/opencode` on every OS. */
  openCodeStoreRoot: string
}

/** The providers' folders for the Host's environment and the person's home folder (HO-09). */
export function observedProviderFolders(
  env: Readonly<Record<string, string | undefined>>,
  home: string
): ObservedProviderFolders {
  return {
    claudeConfigDir: claudeConfigDirOf(env, home),
    codexHome: codexHomeOf(env, home),
    geminiDir: antigravityGeminiDirOf(home),
    openCodeStoreRoot: openCodeStoreRootOf(home)
  }
}

export interface ObservationAdapterDeps {
  folders: ObservedProviderFolders
  /** Read only: the adapters never write a provider's files (09 §1; T-30). */
  fs: FileSystem
  clock: Clock
  /**
   * The kernel probe the Claude adapter's #45 guard reads (ADR-014 item 2), and the process listing
   * the Codex and OpenCode adapters close a session by (owner amendment I).
   */
  processes: Pick<ProcessControl, 'probe' | 'isRunning' | 'currentBootIdentity' | 'listProcesses'>
  /** `openReadOnlySnapshot` of `host/platform/sqlite` (R11): the only way a provider DB is read. */
  openSnapshot: ReadOnlySnapshotOpener
}

/** The catalog ids of the four observed providers (`contracts/catalog/ids.mjs`). */
const OBSERVED: Readonly<Record<keyof ObservedProviderFolders, ProviderId>> = {
  claudeConfigDir: 'claude',
  codexHome: 'codex',
  geminiDir: 'antigravity',
  openCodeStoreRoot: 'opencode'
}

/**
 * The four observation adapters in the loop's order, each told the other providers' folders for
 * the longest-prefix dispatch (FM-093), and the registries that answer a process identity: only
 * Claude's (15 §5 "pid for kill / focus"; spike S-014-1 `partial` for the others).
 */
export function observationAdapters(deps: ObservationAdapterDeps): {
  adapters: ObservationAdapter[]
  processRegistries: ObservedProcessRegistry[]
} {
  const { folders, fs, clock, processes, openSnapshot } = deps
  const others = (own: keyof ObservedProviderFolders): string[] =>
    (Object.keys(folders) as Array<keyof ObservedProviderFolders>)
      .filter((key) => key !== own)
      .map((key) => folders[key])
  const claude = new ClaudeObservationAdapter({
    providerId: OBSERVED.claudeConfigDir,
    configDir: folders.claudeConfigDir,
    claimedRoots: others('claudeConfigDir'),
    fs,
    clock,
    processes
  })
  // Owner amendment I: one process listing, shared by the providers that close by process.
  const listing = new SharedProcessListing({
    processes,
    stems: [...CODEX_PROCESS_STEMS, ...OPENCODE_PROCESS_STEMS],
    clock
  })
  return {
    adapters: [
      claude,
      new CodexObservationAdapter({
        providerId: OBSERVED.codexHome,
        codexHome: folders.codexHome,
        claimedRoots: others('codexHome'),
        fs,
        clock,
        openSnapshot,
        processWatch: new ProcessGoneWatch({ listing, stems: CODEX_PROCESS_STEMS, clock })
      }),
      new AntigravityObservationAdapter({
        providerId: OBSERVED.geminiDir,
        geminiDir: folders.geminiDir,
        claimedRoots: others('geminiDir'),
        fs,
        clock,
        openSnapshot
      }),
      new OpenCodeObservationAdapter({
        providerId: OBSERVED.openCodeStoreRoot,
        storeRoot: folders.openCodeStoreRoot,
        openSnapshot,
        processWatch: new ProcessGoneWatch({ listing, stems: OPENCODE_PROCESS_STEMS, clock })
      })
    ],
    processRegistries: [claude]
  }
}

/** The Host bus as the observation wiring uses it: observation publishes and its route reads. */
export type ObservationWiringBus = DomainEventBus<ObservationEvent>

export interface ObservationWiringDeps {
  /** The module's three stores over the Host database (`createSqliteObservationStores`). */
  stores: { cursors: CursorStore; sessions: ObservedSessionStore; ended: EndedAgentLedger }
  /** The adapters and registries `observationAdapters` built. */
  adapters: readonly ObservationAdapter[]
  processRegistries: readonly ObservedProcessRegistry[]
  /** The Host's transaction runner (16 §2.2), also the bus's transaction scope. */
  transactions: TransactionRunner
  /** The Host's one event bus (16 §2.3). */
  bus: ObservationWiringBus
  fs: FileSystem
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /**
   * The `ObservedBatchSink` bridge's sink, as `cut1Rollback.ts` chose it; `noObservedBatchSinkYet` without
   * the conversation half, `observationWritesOff` in a cut-1 rollback build.
   */
  sink: ObservedBatchSink
}

export interface WiredObservation {
  /** The one instance. */
  observation: Observation
  /** Crew's half of the binding (routes/crew.ts). */
  crew: CrewObservationBinding
  /**
   * Boot step 7 (16 §8.2): `catchUp()`, then `start()`; the pass may go on after `ready`. `null`
   * while the sink is `noObservedBatchSinkYet` (nothing may move a cursor past what nothing stores) or
   * `observationWritesOff` (a cut-1 rollback build): `observesWith`.
   */
  start: (() => void) | null
  /** The hook ingress's entry point (05 §3.3): brings the next cycle forward. */
  nudge(hint: NudgeHint): void
  /** Resolves once no observation cycle is in flight (tests; drain). */
  idle(): Promise<void>
}

/** Boot step 4: constructs the module over its stores and adapters and subscribes its route. */
export function wireObservation(deps: ObservationWiringDeps): WiredObservation {
  const { bus, log, stores } = deps
  // Owner amendment I: a resumed Codex or OpenCode session's identity depends on the ledger.
  for (const adapter of deps.adapters) {
    if (
      adapter instanceof CodexObservationAdapter ||
      adapter instanceof OpenCodeObservationAdapter
    ) {
      adapter.useEndedLedger(stores.ended)
    }
  }
  const observation = createObservation({
    adapters: deps.adapters,
    processRegistries: deps.processRegistries,
    fs: deps.fs,
    cursors: stores.cursors,
    sessions: stores.sessions,
    ended: stores.ended,
    sink: deps.sink,
    transactions: deps.transactions,
    bus,
    clock: deps.clock,
    scheduler: deps.scheduler,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch,
    log
  })

  // 05 §4: diagnostics' half of the provider-error route (19 §6 `warn`: a handled degradation).
  bus.subscribe('ProviderErrorObserved', ({ payload }) =>
    log.record({
      level: 'warn',
      event: PROVIDER_ERROR_EVENT,
      subsystem: 'observation',
      provider: payload.providerId,
      causeClass: payload.cause,
      ...(payload.dwarfId === undefined ? {} : { dwarfId: payload.dwarfId }),
      outcome: 'failed',
      msg: 'a provider of an observed session errored or became unreadable'
    })
  )

  return {
    observation,
    crew: {
      processIdentities: observation.processIdentities,
      control: observation.control,
      sessions: stores.sessions
    },
    start: observesWith(deps.sink)
      ? () => {
          // 16 §8.2 step 7: the catch-up pass first, from the cursors the last Host left (INV-98),
          // then the live loop, whose first cycle the loop runs after the pass. `ready` does not wait
          // for the pass: before `ready` only the recovery classification (16 §4.3 `catchUp`; ADR-015
          // item 3), so a long offline history never delays the window.
          const pass = observation.control.catchUp()
          observation.control.start()
          pass.catch((error: unknown) =>
            log.record({
              level: 'error',
              event: 'uncaught',
              subsystem: 'host',
              errCode: errorCode(error)
            })
          )
        }
      : null,
    nudge: (hint) => observation.control.nudge(hint),
    idle: () => observation.whenIdle()
  }
}
