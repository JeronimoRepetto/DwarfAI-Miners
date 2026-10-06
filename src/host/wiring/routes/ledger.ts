// The ledger module's wiring (05 §3.10, §4; 16 §8.2, §8.3), as routes/observation.ts: the ledger
// serves no seam-B member, so it has no `serve` half; its totals reach the board through the mines
// wiring (`WiredLedger.totals`, read by the `mines` section and the board frames, routes/mines.ts).
//
// - `wireLedger`, run by boot step 4 before observation (whose batch sink holds the ledger's half)
//   and mines (whose section and frames read its totals): `createLedger` over the
//   `SqliteLedgerRepository` the composition root built (preferences' install-moment writer is the
//   same instance) and the coal backfill's scanner, the `ledger.changed` frame (frames/ledger.ts,
//   14 §2.4 B-F20), the ledger's half of the `ObservedBatchSink` bridge
//   (bridges/observedBatchSink.ts: usage → `creditUsage` inside the batch transaction, AMENDMENT-10),
//   and the 05 §4 route of this module:
//   - `MineMeasured` (mines) → `creditSealedUnits(mineId)`: the stored, sealed units of a mine
//     whose tier was not known are credited once (INV-94; AMENDMENT-10). The event is published
//     after the walk's commit, so the credit runs in its own transaction and publishes after it.
// - `route`, run by boot step 4 once mines exists: the backfill's folder → mine resolution reads
//   mines' public queries (05 §1.3 has no ledger → mines edge: the resolution is composed here).
// - `startBackfill`, run once the boot answered `ready` through `startBackfillWhenObserving`
//   (held off while the batch sink is the placeholder, as observation is) (07 S19.02,
//   S19.04): `runCoalBackfill`, which runs only while an install moment exists, no reset saga is
//   unfinished (INV-97) and the backfill is not `done`, so each Host `ready` resumes a `paused` one
//   until it is. A failed run is logged as an uncaught error and resolves null: the Host goes on,
//   and the next `ready` runs it again from its recorded scan units (S19.07).
//
// The backfill's folders (`resolveMine`): the mine on the board whose identity is the folder's mine
// key, the worktree fold included (`MineIdentityResolver`, ADR-030; 11 F10 step 3). Package gap:
// the frozen `MinesQueries` (16 §4.1) has no read-only "mine of this folder" member and
// `resolveForSession` creates mines, so the wiring folds the folder with the mines module's own
// resolver adapter and finds the key among `MinesQueries.list`. A removed mine pays no coal: it is
// not on the board, and its folder is no mine until it is reattached.
//
// Not routed here, and why:
// - `DriverUsageReported` (suppliers) → `creditUsage(…, 'driver')`: suppliers publishes no usage of
//   an owned session yet (later: EPIC-10).
// - The Reset saga's ledger step (`createLedgerResetStep`) and the backfill's abort on a new Reset
//   (S19.06): later: ISSUE-097, ISSUE-121, EPIC-13. The abort signal is this wiring's own.
import { HostInvariantError } from '../../kernel/domain/errors'
import type { FolderPath, HostEpoch, MineId } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import {
  createLedger,
  type BackfillReport,
  type HistoricalUsageScanner,
  type Ledger,
  type LedgerEvent,
  type LedgerRepository
} from '../../modules/ledger'
import type { MinesEvent, MinesQueries } from '../../modules/mines'
import type { ObservedBatchSink } from '../../modules/observation'
import { publishLedgerFrames, type LedgerFramePublisher } from '../../transport/frames/ledger'
import type { MineTotalsReader } from '../../transport/mappers/wire'
import { errorCode } from '../boot'
import { ledgerBatchHalf, type ObservedBatchHalf } from '../bridges/observedBatchSink'
import { noObservedBatchSinkYet } from './observation'

/** The events the ledger wiring routes or projects: one Host bus carries them all (16 §2.3). */
export type LedgerRouteEvent = LedgerEvent | MinesEvent

/** The Host bus as the ledger wiring uses it: the ledger publishes; mines is read. */
export type LedgerWiringBus = Pick<DomainEventBus<LedgerEvent>, 'publish' | 'subscribe'> &
  Pick<DomainEventBus<MinesEvent>, 'subscribe'>

/** Which mine a folder belongs to: the mines module's `MineIdentityResolver` adapter (ADR-030). */
export interface MineKeyResolver {
  resolve(cwd: string): Promise<{ mineKey: string }>
}

/** A folder's mine on the board, or null: what the coal backfill's scanner credits to. */
export type ResolveMine = (folder: FolderPath) => Promise<MineId | null>

export interface LedgerWiringDeps {
  /** `SqliteLedgerRepository` over the Host database (also preferences' install-moment writer). */
  repository: LedgerRepository
  /** The Host's transaction runner, also the bus's transaction scope (16 §2.2). */
  transactions: TransactionRunner & TransactionScope
  /** The Host's one event bus (16 §2.3). */
  bus: LedgerWiringBus
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /** Where `ledger.changed` goes: the connection registry. */
  frames: LedgerFramePublisher
  /** The worktree fold of the backfill's folders (`createHostGitRepoInspector`). */
  resolver: MineKeyResolver
  /** Builds the coal backfill's `ProviderHistoryScanner` over the folder → mine resolution. */
  scanner(resolveMine: ResolveMine): HistoricalUsageScanner
}

export interface WiredLedger {
  /** The one instance. */
  ledger: Ledger
  /** The mines' totals as the board reads them (`LedgerQueries.totals`). */
  totals: MineTotalsReader
  /** The ledger's half of the `ObservedBatchSink` bridge. */
  batchHalf: ObservedBatchHalf
  /** Boot step 4, once mines exists: the backfill's folder → mine resolution. */
  route(deps: { mines: Pick<MinesQueries, 'list'> }): void
  /** After `ready`: one run of the coal backfill (S19.02, S19.04); null when it failed (logged). */
  startBackfill(): Promise<BackfillReport | null>
}

/** Boot step 4: constructs the module, its frame and its batch half, and subscribes its route. */
export function wireLedger(deps: LedgerWiringDeps): WiredLedger {
  const { bus, log } = deps
  const bound: { mines?: Pick<MinesQueries, 'list'> } = {}
  const resolveMine: ResolveMine = async (folder) => {
    const mines = bound.mines
    if (mines === undefined) {
      throw new HostInvariantError('the backfill resolves folders after mines is routed')
    }
    const { mineKey } = await deps.resolver.resolve(folder)
    // A removed mine is not on the board and pays nothing.
    const mine = mines
      .list({ sortBy: 'name', direction: 'asc' })
      .find((summary) => summary.path === mineKey && !summary.removed)
    return mine?.mineId ?? null
  }
  const ledger = createLedger({
    repository: deps.repository,
    transactions: deps.transactions,
    scope: deps.transactions,
    bus,
    clock: deps.clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch,
    scanner: deps.scanner(resolveMine),
    log
  })
  publishLedgerFrames({ events: bus, ledger: ledger.queries, frames: deps.frames })

  // 05 §4: `MineMeasured` → `creditSealedUnits` (INV-94; AMENDMENT-10).
  bus.subscribe('MineMeasured', ({ payload }) => {
    ledger.commands.creditSealedUnits(payload.mineId)
  })

  const backfill = new AbortController()
  return {
    ledger,
    totals: { totalsOf: (mineId) => ledger.queries.totals(mineId) },
    batchHalf: ledgerBatchHalf(ledger),
    route: ({ mines }) => {
      if (bound.mines !== undefined) throw new HostInvariantError('the ledger is routed once')
      bound.mines = mines
    },
    startBackfill: () =>
      ledger.commands.runCoalBackfill(backfill.signal).catch((error: unknown) => {
        log.record({
          level: 'error',
          event: 'uncaught',
          subsystem: 'host',
          errCode: errorCode(error)
        })
        return null
      })
  }
}

/**
 * The production start of the coal backfill once the Host is `ready`: null, and nothing run, while
 * observation's batch sink is `noObservedBatchSinkYet`, the same gate that keeps observation
 * stopped (routes/observation.ts). The backfill pays only folders that are already mines, and
 * mines appear through observation. A run before observation could create any would end `done`
 * with nothing paid, and the history before the install moment would never become coal.
 * ISSUE-108 turns both on together. What a mine first seen after the backfill finished receives
 * is O-11-10's ruling (owner).
 */
export function startBackfillWhenObserving(
  ledger: Pick<WiredLedger, 'startBackfill'>,
  sink: ObservedBatchSink
): Promise<BackfillReport | null> | null {
  return sink === noObservedBatchSinkYet ? null : ledger.startBackfill()
}
