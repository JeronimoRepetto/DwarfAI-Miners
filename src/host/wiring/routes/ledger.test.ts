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
import type { MineSummary } from '../../modules/mines'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { composeObservedBatchSink, type ObservedBatchHalf } from '../bridges/observedBatchSink'
import {
  routeMineBackfillWhenObserving,
  routeResetFinished,
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
function compose(
  conversation: ObservedBatchHalf | null,
  scanner: HistoricalUsageScanner = NO_HISTORY,
  board: MineSummary[] = []
) {
  const { db } = openTemplateCopy()
  db.exec(`DELETE FROM install_moment`)
  db.run(`INSERT INTO install_moment (id, at, reason) VALUES (1, ?, 'fresh-install')`, [T0 - 1])
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  const bus = new InProcessEventBus<LedgerRouteEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  const ledger = wireLedger({
    repository: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
    transactions,
    bus,
    clock,
    ids,
    hostEpoch: 'epoch-096' as HostEpoch,
    log: new RecordingDiagnosticsLog(),
    frames: { publishFrame: () => undefined },
    resolver: { resolve: (cwd) => Promise.resolve({ mineKey: cwd }) },
    scanner: () => scanner
  })
  ledger.route({ mines: { list: () => board } })
  const batches = composeObservedBatchSink({
    transactions,
    ledger: ledger.batchHalf,
    conversation
  })
  return { db, ledger, sink: batches.sink, bus }
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

describe('the coal backfill abort on a new Reset metrics (ISSUE-121)', () => {
  it('[S19.06] MetricsResetStarted aborts the running coal backfill, and a later run is not aborted', async () => {
    const signals: AbortSignal[] = []
    let release: () => void = () => undefined
    const scanning = new Promise<void>((resolve) => {
      release = resolve
    })
    /** A provider history with nothing in it, read only once `release` is called. */
    const held: HistoricalUsageScanner = {
      scan: (_before, _budget, signal) => {
        signals.push(signal)
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await scanning
              return { done: true, value: undefined }
            }
          })
        }
      }
    }
    const { ledger, bus } = compose(CONVERSATION, held)

    const running = ledger.startBackfill()
    bus.publish({
      eventId: 'e-1',
      hostEpoch: 'epoch-096',
      at: T0,
      type: 'MetricsResetStarted',
      payload: { resetId: 'reset-1', epoch: 1 }
    } as never)
    release()

    expect(signals.map((signal) => signal.aborted)).toEqual([true])
    expect(await running).toMatchObject({ outcome: 'aborted' })
    const next = await ledger.startBackfill()
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
    expect(next).toMatchObject({ outcome: 'done' })
  })
})

describe('the ledger after a Reset metrics (08 §2.9; ISSUE-121)', () => {
  const MINE = '00000000-0000-7000-8000-0000000121c1' as MineId
  const DWARF = '00000000-0000-7000-8000-0000000121c2'
  const ENVELOPE = { eventId: 'e-1', hostEpoch: 'epoch-121', at: T0 }
  const SUMMARY = {
    mineId: MINE,
    name: 'moria',
    path: '/work/moria',
    tier: 'gold',
    lastUsedAt: T0,
    presentDwarfs: 1,
    removed: false
  } as MineSummary

  /**
   * A measured mine with a present dwarf whose unit was stored while a reset ran (`install-moment`
   * reached, not `done`), and whose `MineMeasured` arrived before `done`: nothing credited it.
   */
  function heldDuringReset(conversation: ObservedBatchHalf | null) {
    const h = compose(conversation, NO_HISTORY, [SUMMARY])
    h.db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, tier, has_been_measured,
         measured_at, created_at, last_used_at)
       VALUES (?, '/work/moria', 'moria', 'moria', 'active', 'gold', 1, ?, ?, ?)`,
      [MINE, T0, T0, T0]
    )
    h.db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at)
       VALUES (?, ?, 'claude', 'session-1', 'Gimli', 'foreman', 'running', 'none-yet', ?, ?)`,
      [DWARF, MINE, T0, T0]
    )
    h.db.run(
      `INSERT INTO reset_journal (id, epoch, step, started_at, step_at)
       VALUES ('00000000-0000-7000-8000-0000000121e1', 1, 'install-moment', ?, ?)`,
      [T0, T0]
    )
    const stored = h.ledger.ledger.commands.creditUsage(
      {
        sourceKey: 'claude:session-1:msg-1',
        unitKey: 'claude:session-1:msg-1',
        dwarfId: DWARF,
        fidelity: 1,
        tokens: { inputNet: 0, output: 60_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        sealed: true,
        providerTime: T0 + 1,
        observedAt: T0 + 1
      },
      'transcript'
    )
    // The recreated mine's walk ended before `done`: its route credits nothing during a reset.
    h.bus.publish({ ...ENVELOPE, type: 'MineMeasured', payload: { mineId: MINE } } as never)
    const runs: Array<Promise<unknown>> = []
    routeResetFinished(
      {
        creditHeldUnits: () => h.ledger.creditHeldUnits(),
        startBackfill: () => {
          const run = h.ledger.startBackfill()
          runs.push(run)
          return run
        }
      },
      h.bus,
      h.sink
    )
    const finish = () => {
      h.db.run(`UPDATE reset_journal SET step = 'done', finished_at = ? WHERE epoch = 1`, [T0 + 2])
      h.bus.publish({
        ...ENVELOPE,
        type: 'MetricsResetFinished',
        payload: { resetId: '00000000-0000-7000-8000-0000000121e1', epoch: 1 }
      } as never)
    }
    const entries = () => Number(h.db.all('SELECT count(*) AS n FROM ledger_entries')[0]?.['n'])
    return { ...h, stored, finish, runs, entries }
  }

  it('[ADR-023, INV-94] a unit held during the reset whose re-measure finished before done is credited after MetricsResetFinished', async () => {
    const h = heldDuringReset(CONVERSATION)
    expect(h.stored).toBe('stored')
    expect(h.entries()).toBe(0)

    h.finish()
    await Promise.all(h.runs)

    expect(h.entries()).toBe(1)
    expect(h.ledger.totals.totalsOf(MINE).gold.tokens).toBe(60_000)
    // The backfill re-runs over the new moment while observation runs (S19.02).
    expect(h.runs).toHaveLength(1)
    expect(backfillState(h.db).state).toBe('done')
  })

  it('[S19.02] over a sink that writes nothing the reset end credits the held units and starts no backfill', async () => {
    const h = heldDuringReset(null)

    h.finish()
    await Promise.all(h.runs)

    expect(h.entries()).toBe(1)
    expect(h.runs).toStrictEqual([])
    expect(backfillState(h.db)).toEqual({ state: 'not-started', doneAt: null })
  })
})
