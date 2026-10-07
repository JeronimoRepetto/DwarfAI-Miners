// layer: L3
// The production start of the coal backfill (routes/ledger.ts `startBackfillWhenObserving`), as
// host/main.ts calls it after `ready`, over a copy of the template database: while the
// `ObservedBatchSink` bridge has no conversation half its sink is the placeholder, observation
// is not started, and the backfill must not run either. A run over a Host with no mines would end
// `done` with nothing paid, so the history before the install moment could never be credited.
import { describe, expect, it } from 'vitest'
import type { HostEpoch, Instant, MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { HistoricalUsageScanner } from '../../modules/ledger'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { composeObservedBatchSink, type ObservedBatchHalf } from '../bridges/observedBatchSink'
import {
  routeMineBackfillWhenObserving,
  startBackfillWhenObserving,
  wireLedger,
  type LedgerRouteEvent
} from './ledger'
import { observationWritesOff } from './observation'

const T0 = 1_790_800_000_000 as Instant

/** A provider history with nothing in it: a run over it ends `done` at once. */
const NO_HISTORY: HistoricalUsageScanner = {
  scan: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined })
    })
  })
}

/** A conversation half that stores nothing (later: ISSUE-108). */
const CONVERSATION: ObservedBatchHalf = {
  apply: () => undefined,
  joinedEvents: { publish: () => undefined, discard: () => undefined }
}

function backfillState(db: SqliteDatabase) {
  const row = db.all(`SELECT backfill_state, backfill_done_at FROM install_moment WHERE id = 1`)[0]
  return { state: row?.['backfill_state'], doneAt: row?.['backfill_done_at'] }
}

/** The ledger and the bridge as host/main.ts composes them at boot step 4. */
function compose(conversation: ObservedBatchHalf | null) {
  const { db } = openTemplateCopy()
  db.exec(`DELETE FROM install_moment`)
  db.run(`INSERT INTO install_moment (id, at, reason) VALUES (1, ?, 'fresh-install')`, [T0 - 1])
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  const ledger = wireLedger({
    repository: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
    transactions,
    bus: new InProcessEventBus<LedgerRouteEvent>({
      transactionScope: transactions,
      onHandlerError: (failure) => {
        throw failure.error
      }
    }),
    clock,
    ids,
    hostEpoch: 'epoch-096' as HostEpoch,
    log: new RecordingDiagnosticsLog(),
    frames: { publishFrame: () => undefined },
    resolver: { resolve: (cwd) => Promise.resolve({ mineKey: cwd }) },
    scanner: () => NO_HISTORY
  })
  ledger.route({ mines: { list: () => [] } })
  const batches = composeObservedBatchSink({
    transactions,
    ledger: ledger.batchHalf,
    conversation
  })
  return { db, ledger, sink: batches.sink }
}

describe('the coal backfill start of the production Host (ISSUE-096)', () => {
  it('[S19.02] while the batch sink is the placeholder the backfill is not started and writes no state', async () => {
    const { db, ledger, sink } = compose(null)

    const started = startBackfillWhenObserving(ledger, sink)
    await started

    expect(started).toBeNull()
    expect(backfillState(db)).toEqual({ state: 'not-started', doneAt: null })
  })

  it('[S19.02] once the batch sink is real the backfill runs after ready', async () => {
    const { db, ledger, sink } = compose(CONVERSATION)

    const report = await startBackfillWhenObserving(ledger, sink)

    expect(report).toMatchObject({ outcome: 'done' })
    expect(backfillState(db).state).toBe('done')
  })
})

describe('the per-mine coal backfill route (ISSUE-108; O-11-10)', () => {
  const MINE = '00000000-0000-7000-8000-0000000108a2' as MineId

  /** The route over a bus of its own and a ledger that records each per-mine run it is asked for. */
  function routed(sink: Parameters<typeof routeMineBackfillWhenObserving>[2]) {
    const { db } = openTemplateCopy()
    const bus = new InProcessEventBus<LedgerRouteEvent>({
      transactionScope: new SqliteTransactionRunner(db),
      onHandlerError: (failure) => {
        throw failure.error
      }
    })
    const runs: MineId[] = []
    const subscribed = routeMineBackfillWhenObserving(
      {
        startMineBackfill: (mineId) => {
          runs.push(mineId)
          return Promise.resolve(null)
        }
      },
      bus,
      sink
    )
    const envelope = { eventId: 'e-1', hostEpoch: 'epoch-108', at: T0 }
    const publish = (type: 'MineCreated' | 'MineReattached') =>
      bus.publish({ ...envelope, type, payload: { mineId: MINE } } as never)
    return { subscribed, runs, publish }
  }

  it('[INV-95] MineCreated and MineReattached each start one per-mine coal backfill of that mine while observation runs', () => {
    const h = routed(compose(CONVERSATION).sink)

    h.publish('MineCreated')
    h.publish('MineReattached')

    expect(h.subscribed).toBe(true)
    expect(h.runs).toEqual([MINE, MINE])
  })

  it('[ADR-001] over a sink that writes nothing (the placeholder or a cut-1 rollback build) no per-mine backfill is routed', () => {
    for (const sink of [compose(null).sink, observationWritesOff]) {
      const h = routed(sink)

      h.publish('MineCreated')
      h.publish('MineReattached')

      expect(h.subscribed).toBe(false)
      expect(h.runs).toEqual([])
    }
  })
})
