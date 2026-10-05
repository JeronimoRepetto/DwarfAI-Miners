// layer: L2
// L2 flow (17 §1.2; 12 UC-024 "Reopen app and rehydrate"; 13 FM-097): observation, mines, crew and
// ledger composed through their public index.ts over one copy of the template database, with the
// 05 §4 routes of this flow declared here as `host/wiring` will declare them (later: ISSUE-093…
// ISSUE-096):
//
// - `SessionObserved` → `mines.resolveForSession(cwd, firstMessage)` → `crew.arrive` on `{ mineId }`;
// - `SessionClosedObserved` → `crew.sessionClosed(…, 'closed-elsewhere')` (S4.33, S4.39);
// - the `ObservedBatchSink` bridge hands a batch's usage to `ledger.creditUsage(…, 'transcript')`
//   inside the batch transaction, and the ledger's held events are published after its commit
//   (AMENDMENT-10; ledger `joinedEvents`, ISSUE-076).
//
// A Host stops (S4.37: Stop everything and quit), the provider files keep changing while no Host
// runs, and a new Host over the same database boots in the 16 §8.2 step 7 order: `catchUp()`, then
// `start()` (ISSUE-095 composes that order in `host/main.ts`). The provider is a test-local
// stand-in over in-memory files, read from a watermark cursor with the same record ids at every read
// (HO-37), because the simulated provider writes no usage. A new mine's measurement (ISSUE-065's
// walk) is played by the `remeasure` stand-in. Every text is invented.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { FolderPath, MineId, ProviderIdentity } from '../../kernel/domain/values'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import { createCrew, type CrewEvent } from '../../modules/crew'
import { createLedger, type HistoricalUsageScanner, type LedgerEvent } from '../../modules/ledger'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import { createMines, type MinesEvent } from '../../modules/mines'
import {
  OBSERVATION_POLL_MS,
  createObservation,
  createSqliteObservationStores,
  type Cursor,
  type ObservationAdapter,
  type ObservationEvent,
  type ObservedBatchSink,
  type ObservedEvent,
  type SourceFile
} from '../../modules/observation'
import { NodeFs } from '../../platform/fs/NodeFs'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'

type HostEvent = ObservationEvent | MinesEvent | CrewEvent | LedgerEvent

const T0 = 1_790_000_000_000
const INSTALL = T0 - 86_400_000
const PROVIDER = 'simulated'
const identityOf = (sessionId: string): ProviderIdentity => ({
  providerId: PROVIDER,
  providerSessionId: sessionId
})

/**
 * The provider's session files: one stream per session, a list of records the provider appends to.
 * A record's `sourceEventId` is its position, so a re-read yields the same ids (HO-37).
 */
class ProviderFiles implements ObservationAdapter {
  readonly providerId = PROVIDER
  readonly cursorKind = 'watermark' as const
  private readonly files = new Map<string, ObservedEvent[]>()

  capabilities(): ReturnType<ObservationAdapter['capabilities']> {
    return { observe: true }
  }

  /** The session opens in `cwd` and the person writes its first message. */
  open(sessionId: string, cwd: FolderPath, at: number): void {
    const identity = identityOf(sessionId)
    this.append(sessionId, (id) => ({ kind: 'session', sourceEventId: id, identity, cwd, at }))
    this.say(sessionId, 'person', 'Dig the north seam', at)
  }

  say(sessionId: string, role: 'person' | 'dwarf', text: string, at: number): void {
    this.append(sessionId, (id) => ({
      kind: 'entries',
      sourceEventId: id,
      identity: identityOf(sessionId),
      entries: [{ sourceKey: `${PROVIDER}:${sessionId}:${id}`, role, text, providerTime: at }]
    }))
  }

  /** One sealed usage unit of `tokens` input tokens. */
  spend(sessionId: string, tokens: number, at: number): void {
    this.append(sessionId, (id) => ({
      kind: 'usage',
      sourceEventId: id,
      identity: identityOf(sessionId),
      usage: {
        sourceKey: `${PROVIDER}:${sessionId}:${id}`,
        unitKey: `${sessionId}:unit-${id}`,
        fidelity: 1,
        tokens: { inputNet: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        sealed: true,
        providerTime: at
      }
    }))
  }

  /** The session's process ended (finished, or crashed) and the provider wrote its ending. */
  end(sessionId: string, at: number): void {
    this.append(sessionId, (id) => ({
      kind: 'closed',
      sourceEventId: id,
      identity: identityOf(sessionId),
      at
    }))
  }

  discover(): Promise<SourceFile[]> {
    return Promise.resolve(
      [...this.files].map(([sessionId, records]) => ({
        streamId: `${PROVIDER}:${sessionId}`,
        adapterId: PROVIDER,
        path: sessionId,
        fileIdentity: `file-${sessionId}`,
        size: records.length
      }))
    )
  }

  read(
    source: SourceFile,
    from: Cursor | null
  ): Promise<{ events: ObservedEvent[]; next: Cursor; warnings: string[] }> {
    const records = this.files.get(source.path) ?? []
    return Promise.resolve({
      events: records.slice(from?.value ?? 0),
      next: {
        adapterId: PROVIDER,
        kind: 'watermark',
        value: records.length,
        fileIdentity: source.fileIdentity
      },
      warnings: []
    })
  }

  private append(sessionId: string, record: (id: string) => ObservedEvent): void {
    const records = this.files.get(sessionId) ?? []
    records.push(record(`r${records.length}`))
    this.files.set(sessionId, records)
  }
}

/** The coal backfill is not part of this flow: its scanner finds no history. */
const NO_HISTORY: HistoricalUsageScanner = {
  scan: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined })
    })
  })
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** The composed Host slice over a template copy; `quit` and `boot` are S4.37 and a reopen. */
async function host() {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'dwarfai-offline-')))
  roots.push(root)
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  db.exec(`DELETE FROM install_moment`)
  db.run(`INSERT INTO install_moment (id, at, reason) VALUES (1, ?, 'fresh-install')`, [INSTALL])
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const bus = new RecordingEventBus<HostEvent>({ transactionScope: transactions })
  const fs = new NodeFs()
  const files = new ProviderFiles()
  const stores = createSqliteObservationStores({ db, scope: transactions, clock })

  let epoch = 0
  let routes = new Set<Promise<void>>()
  const boot = () => {
    epoch += 1
    const hostEpoch = `epoch-0078-${epoch}`
    const mines = createMines({
      db,
      transactions,
      mapSites: [{ xPct: 10, yPct: 20 }],
      random: () => 0,
      fs,
      clock,
      ids,
      bus,
      hostEpoch,
      // ISSUE-065's walk, played: every new mine measures as copper.
      remeasure: (mineId) =>
        transactions.inTransaction(() =>
          db.run(
            `UPDATE mines SET tier = 'copper', source_weight_bytes = 524288, has_been_measured = 1,
               measured_at = ? WHERE id = ?`,
            [clock.now(), mineId]
          )
        )
    })
    const crew = createCrew({
      db,
      transactions,
      lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
      bus,
      clock,
      scheduler,
      ids,
      hostEpoch,
      links: { owned: () => false, hasDeliveryRoute: () => false }
    })
    const ledger = createLedger({
      repository: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
      transactions,
      scope: transactions,
      bus,
      clock,
      ids,
      hostEpoch,
      scanner: NO_HISTORY,
      log: new RecordingDiagnosticsLog()
    })
    // The ledger half of the ObservedBatchSink bridge (ISSUE-096 registers it).
    const sink: ObservedBatchSink = {
      apply: (batch) => {
        for (const usage of batch.usage) ledger.commands.creditUsage(usage, 'transcript')
      }
    }
    // Each batch transaction, then the events the ledger held: after the commit, or dropped.
    const batchTransactions: TransactionRunner = {
      inTransaction<T>(work: () => T): T {
        let result: T
        try {
          result = transactions.inTransaction(work)
        } catch (error) {
          ledger.joinedEvents.discard()
          throw error
        }
        ledger.joinedEvents.publish()
        return result
      }
    }
    const observation = createObservation({
      adapters: [files],
      fs,
      ...stores,
      sink,
      transactions: batchTransactions,
      bus,
      clock,
      scheduler,
      ids,
      hostEpoch,
      log: new RecordingDiagnosticsLog()
    })
    // The 05 §4 routes of this flow, for this Host run.
    const pending = new Set<Promise<void>>()
    routes = pending
    const unsubscribe = [
      bus.subscribe('SessionObserved', ({ payload }) => {
        const route = (async () => {
          const firstMessage = payload.firstMessage ?? false
          const resolved = await mines.commands.resolveForSession(payload.cwd, firstMessage)
          if (!('mineId' in resolved)) return
          crew.commands.arrive({
            mineId: resolved.mineId,
            identity: payload.identity,
            rank: 'foreman',
            status: firstMessage ? 'working' : 'idle'
          })
        })()
        pending.add(route)
        void route.finally(() => pending.delete(route))
      }),
      bus.subscribe('SessionClosedObserved', ({ payload }) => {
        const dwarfId = stores.sessions.byIdentity(payload.identity)?.dwarfId
        if (dwarfId !== undefined) crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
      })
    ]
    return { mines, crew, ledger, observation, unsubscribe }
  }

  let running = boot()
  /** Every cycle and every route it caused has settled. */
  const settle = async () => {
    for (let n = 0; n < 10; n++) {
      await running.observation.whenIdle()
      if (routes.size === 0) return
      await Promise.all([...routes])
    }
  }
  const poll = async () => {
    await settle()
    clock.advance(OBSERVATION_POLL_MS)
    await settle()
  }

  return {
    db,
    clock,
    bus,
    files,
    get crew() {
      return running.crew
    },
    get ledger() {
      return running.ledger
    },
    get observation() {
      return running.observation
    },
    settle,
    poll,
    /** The first Host: it starts its live loop and sees what is there. */
    async start() {
      await running.observation.control.catchUp()
      running.observation.control.start()
      await settle()
    },
    /** Stop everything and quit (S4.37): the Host is gone, nothing is observed. */
    quit() {
      running.observation.control.stop()
      for (const off of running.unsubscribe) off()
    },
    /**
     * The person reopens the app: a new Host boots and catches up (16 §8.2 step 7, first half),
     * and the routes its events caused settle. Its live loop has not started yet.
     */
    async boot() {
      running = boot()
      await running.observation.control.catchUp()
      await settle()
    },
    /** Then the live loop starts (step 7, second half) and runs two cycles. */
    async live() {
      running.observation.control.start()
      await poll()
      await poll()
    },
    async mine(name: string): Promise<{ mineId: MineId; cwd: FolderPath }> {
      const cwd = join(root, name) as FolderPath
      await mkdir(cwd, { recursive: true })
      const declared = await running.mines.commands.declare(cwd)
      if (!declared.ok || !('mineId' in declared.value)) {
        throw new Error('the fixture mine was refused')
      }
      return { mineId: declared.value.mineId, cwd }
    },
    dwarfOf(sessionId: string) {
      return running.crew.queries
        .presentIdentities()
        .find((p) => p.identity.providerSessionId === sessionId)
    },
    tokens(mineId: MineId): number {
      const totals = running.ledger.queries.totals(mineId)
      return Object.values(totals).reduce((sum, m) => sum + m.tokens, 0)
    }
  }
}

describe('offline activity (FM-097)', () => {
  it('[US-RES-002.AC03] a dwarf whose process ended while the window was closed has departed when the window reopens', async () => {
    const h = await host()
    const { mineId, cwd } = await h.mine('moria')
    h.files.open('s1', cwd, T0)
    await h.start()
    await h.poll()
    expect(h.crew.queries.crewOf(mineId).map((d) => d.status)).toEqual(['working'])
    h.quit()

    // While the app is closed the session finishes its work and its process ends.
    h.clock.advance(3_600_000)
    h.files.say('s1', 'dwarf', 'The north seam is open', h.clock.now())
    h.files.end('s1', h.clock.now())
    await h.boot()

    // Catch-up made the departure: the dwarf is gone, as an ordinary departure …
    expect(h.crew.queries.crewOf(mineId)).toEqual([])
    expect(h.bus.ofType('DwarfDeparted').map((e) => e.payload.cause)).toEqual(['closed-elsewhere'])
    // … and the live loop brings it back never.
    await h.live()
    expect(h.crew.queries.crewOf(mineId)).toEqual([])
    expect(h.bus.ofType('DwarfArrived')).toHaveLength(1)
  })

  it('[US-RES-002.AC04] a dwarf whose process survived the whole time is still present after the reopen', async () => {
    const h = await host()
    const { mineId, cwd } = await h.mine('moria')
    h.files.open('s1', cwd, T0)
    h.files.open('s2', cwd, T0)
    await h.start()
    await h.poll()
    const before = h.crew.queries.crewOf(mineId).map((d) => d.id)
    expect(before).toHaveLength(2)
    h.quit()

    // While the app is closed s1 keeps working and s2 ends.
    h.clock.advance(3_600_000)
    h.files.say('s1', 'dwarf', 'Still digging', h.clock.now())
    h.files.spend('s1', 40_000, h.clock.now())
    h.files.end('s2', h.clock.now())
    await h.boot()

    // After catch-up the survivor is the same dwarf as before the app closed, with what it spent
    // while the app was closed credited; only s2 departed.
    const survivor = () => h.crew.queries.crewOf(mineId).map((d) => d.id)
    expect(survivor()).toEqual([h.dwarfOf('s1')?.dwarfId])
    expect(before).toContain(survivor()[0])
    expect(h.tokens(mineId)).toBe(40_000)
    expect(h.bus.ofType('DwarfDeparted')).toHaveLength(1)
    // The live loop changes nothing about who is still working.
    await h.live()
    expect(survivor()).toEqual([h.dwarfOf('s1')?.dwarfId])
    expect(h.bus.ofType('DwarfArrived')).toHaveLength(2)
    expect(h.tokens(mineId)).toBe(40_000)
  })

  it('[US-RES-003.AC08] a mine whose dwarfs all ended meanwhile has an empty crew after the reopen', async () => {
    const h = await host()
    const { mineId, cwd } = await h.mine('moria')
    h.files.open('s1', cwd, T0)
    h.files.open('s2', cwd, T0)
    await h.start()
    await h.poll()
    expect(h.crew.queries.crewOf(mineId)).toHaveLength(2)
    h.quit()

    h.clock.advance(3_600_000)
    h.files.end('s1', h.clock.now())
    h.files.end('s2', h.clock.now() + 1)
    await h.boot()

    // Its ordinary empty-crew state at once: the mine is still there, with nobody present.
    expect(h.crew.queries.crewOf(mineId)).toEqual([])
    expect(h.bus.ofType('DwarfDeparted')).toHaveLength(2)
    await h.live()
    expect(h.crew.queries.crewOf(mineId)).toEqual([])
  })

  it('[INV-98, ADR-006] a session that started and ended while no Host ran is credited in full, once', async () => {
    const h = await host()
    const { mineId, cwd } = await h.mine('moria')
    await h.start()
    h.quit()

    // While no Host runs, a whole session: it starts, spends two units, and ends.
    h.clock.advance(3_600_000)
    const at = h.clock.now()
    h.files.open('s1', cwd, at)
    h.files.spend('s1', 30_000, at + 1)
    h.files.say('s1', 'dwarf', 'Done with the seam', at + 2)
    h.files.spend('s1', 50_000, at + 3)
    h.files.end('s1', at + 4)
    await h.boot()
    // Catch-up read it from its start (no first-sight baseline, 09 §5.4) and its dwarf arrived; its
    // messages and usage wait for that dwarf, as in any cycle (16 §4.3) …
    expect(h.bus.ofType('DwarfArrived')).toHaveLength(1)
    expect(h.tokens(mineId)).toBe(0)
    // … and the live loop writes them to it.
    await h.live()

    // It arrived and departed, and every unit it spent is credited, once.
    expect(h.bus.ofType('DwarfArrived')).toHaveLength(1)
    expect(h.bus.ofType('DwarfDeparted')).toHaveLength(1)
    expect(h.crew.queries.crewOf(mineId)).toEqual([])
    expect(h.tokens(mineId)).toBe(80_000)
    expect(h.bus.ofType('MaterialCredited')).toHaveLength(2)

    // A second reopen with nothing new adds nothing: no arrival, no credit.
    h.quit()
    await h.boot()
    await h.live()
    expect(h.tokens(mineId)).toBe(80_000)
    expect(h.bus.ofType('MaterialCredited')).toHaveLength(2)
    expect(h.bus.ofType('DwarfArrived')).toHaveLength(1)
  })
})
