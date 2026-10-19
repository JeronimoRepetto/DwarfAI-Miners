// layer: L2
// L2 flow (17 §1.2; 12 UC-006 "A removed mine returns with its ore"; 11 F1 step 5c): observation,
// mines, crew and ledger composed through their public index.ts over one copy of the template
// database, with the 05 §4 routes of this flow declared here as `host/wiring` will declare them
// (later: ISSUE-093…ISSUE-096):
//
// - `SessionObserved` → `mines.resolveForSession(cwd, firstMessage)` → `crew.arrive` on `{ mineId }`;
// - `SessionClosedObserved` → `crew.sessionClosed(…, 'closed-elsewhere')`;
// - the `ObservedBatchSink` bridge hands a batch's usage to `ledger.creditUsage(…, 'transcript')`
//   inside the batch transaction, and the ledger's held events are published after its commit
//   (AMENDMENT-10; ledger `joinedEvents`, ISSUE-076);
// - Remove mine (`mines.removal`) over crew's `endAllIn` and a `SessionTerminator` stand-in that
//   ends each session and records its identity with `observation.control.recordEnded`, as the
//   terminator bridge does after an end (ADR-014 item 7; 16 §4.3).
//
// A removed mine keeps its row and its ledger (INV-06, INV-96); a session observed in its folder,
// or "Add a mine" on that folder, brings the same mine back with the ledger it had, untouched
// (INV-07; NFR-PERS-08). The provider is a test-local stand-in over in-memory files, as in
// `offlineActivity.test.ts`, because the simulated provider writes no usage and ore needs usage.
// A mine's measurement (ISSUE-065's walk) is queued through the `remeasure` stand-in and played by
// `measure`. Every text is invented.
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
import type { DwarfId, FolderPath, MineId, ProviderIdentity } from '../../kernel/domain/values'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import {
  createCrew,
  type CrewEndEvent,
  type CrewEvent,
  type SessionTerminator
} from '../../modules/crew'
import {
  createLedger,
  type HistoricalUsageScanner,
  type LedgerEvent,
  type LiveMaterial
} from '../../modules/ledger'
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

type HostEvent = ObservationEvent | MinesEvent | CrewEvent | CrewEndEvent | LedgerEvent

const T0 = 1_790_000_000_000
const INSTALL = T0 - 86_400_000
const EPOCH = 'epoch-0081'
const PROVIDER = 'simulated'
/** A stream's identity: `<session>` is a session's, `<session>/<agent>` a subagent's of it. */
const identityOf = (stream: string): ProviderIdentity => {
  const [sessionId = stream, agentId] = stream.split('/')
  return {
    providerId: PROVIDER,
    providerSessionId: sessionId,
    ...(agentId === undefined ? {} : { providerAgentId: agentId })
  }
}

/**
 * The provider's session files: one stream per session or subagent, a list of records the provider
 * appends to. A record's `sourceEventId` is its position, so a re-read yields the same ids (HO-37).
 */
class ProviderFiles implements ObservationAdapter {
  readonly providerId = PROVIDER
  readonly cursorKind = 'watermark' as const
  private readonly files = new Map<string, ObservedEvent[]>()

  capabilities(): ReturnType<ObservationAdapter['capabilities']> {
    return { observe: true }
  }

  /** The session (or subagent) opens in `cwd` and the person writes its first message. */
  open(sessionId: string, cwd: FolderPath, at: number): void {
    const identity = identityOf(sessionId)
    const parent = identity.providerAgentId === undefined ? undefined : identity.providerSessionId
    this.append(sessionId, (id) => ({
      kind: 'session',
      sourceEventId: id,
      identity,
      cwd,
      at,
      ...(parent === undefined ? {} : { parentIdentity: identityOf(parent) })
    }))
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

/** The composed Host slice over a template copy, with the 05 §4 routes of this flow. */
async function host() {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'dwarfai-returns-')))
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

  /** The walks `remeasure` queued (ISSUE-065), in order. */
  const walks: MineId[] = []
  const mines = createMines({
    db,
    transactions,
    mapSites: [
      { xPct: 10, yPct: 20 },
      { xPct: 30, yPct: 40 },
      { xPct: 50, yPct: 60 }
    ],
    random: () => 0,
    fs,
    clock,
    ids,
    bus,
    hostEpoch: EPOCH,
    remeasure: (mineId) => void walks.push(mineId)
  })
  const crew = createCrew({
    db,
    transactions,
    lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    links: { owned: () => false, hasDeliveryRoute: () => false }
  })
  const ledger = createLedger({
    repository: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
    transactions,
    scope: transactions,
    bus,
    clock,
    ids,
    hostEpoch: EPOCH,
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
    hostEpoch: EPOCH,
    log: new RecordingDiagnosticsLog()
  })

  // The identity each arrived dwarf came with, as the terminator bridge reads it (05 §4 item 1).
  const identities = new Map<DwarfId, ProviderIdentity>()
  // The terminator bridge, played: every end is confirmed, and the ended identity joins the
  // observation's `EndedAgentLedger` so no late write of it ever surfaces again (ADR-014 item 7).
  const terminator: SessionTerminator = {
    end: (dwarfId) => {
      const identity = identities.get(dwarfId)
      if (identity !== undefined) observation.control.recordEnded(identity, clock.now())
      return Promise.resolve({ kind: 'ended' })
    },
    endAll: () => Promise.reject(new Error('Remove mine ends dwarf by dwarf, never endAll'))
  }
  const removal = mines.removal({
    crew: crew.ends({ terminator, bus }),
    abortWalk: () => undefined
  })

  // The 05 §4 routes of this flow.
  const routes = new Set<Promise<void>>()
  bus.subscribe('SessionObserved', ({ payload }) => {
    const route = (async () => {
      const firstMessage = payload.firstMessage ?? false
      const resolved = await mines.commands.resolveForSession(payload.cwd, firstMessage)
      if (!('mineId' in resolved)) return
      const dwarfId = crew.commands.arrive({
        mineId: resolved.mineId,
        identity: payload.identity,
        rank: 'foreman',
        status: firstMessage ? 'working' : 'idle'
      })
      identities.set(dwarfId, payload.identity)
    })()
    routes.add(route)
    void route.finally(() => routes.delete(route))
  })
  bus.subscribe('SessionClosedObserved', ({ payload }) => {
    const dwarfId = stores.sessions.byIdentity(payload.identity)?.dwarfId
    if (dwarfId !== undefined) crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
  })

  /** Every cycle and every route it caused has settled. */
  const settle = async () => {
    for (let n = 0; n < 10; n++) {
      await observation.whenIdle()
      if (routes.size === 0) return
      await Promise.all([...routes])
    }
  }
  /** One poll of the loop, then everything it caused. */
  const poll = async () => {
    await settle()
    clock.advance(OBSERVATION_POLL_MS)
    await settle()
  }
  const folder = async (name: string): Promise<FolderPath> => {
    const path = join(root, name) as FolderPath
    await mkdir(path, { recursive: true })
    return path
  }
  /** "Add a mine" on `cwd`: the mine's id. */
  const addMine = async (cwd: FolderPath): Promise<MineId> => {
    const declared = await mines.commands.declare(cwd)
    if (!declared.ok || !('mineId' in declared.value)) {
      throw new Error('the fixture mine was refused')
    }
    return declared.value.mineId
  }
  /** ISSUE-065's walk, played: the queued walk of `mineId` finishes at `tier`. */
  const measure = (mineId: MineId, tier: LiveMaterial) =>
    transactions.inTransaction(() =>
      db.run(
        `UPDATE mines SET tier = ?, source_weight_bytes = 524288, has_been_measured = 1,
           measured_at = ?, state = CASE WHEN state = 'measuring' THEN 'active' ELSE state END
         WHERE id = ?`,
        [tier, clock.now(), mineId]
      )
    )
  const remove = async (mineId: MineId) => {
    const removed = await removal.remove(mineId, `remove-${mineId}`)
    if (!removed.ok) throw new Error(`the fixture removal failed: ${removed.error}`)
  }
  /** Every ledger row of `mineId`, in a stable order: entries and totals (09 §5). */
  const ledgerRows = (mineId: MineId) => ({
    entries: db.all(`SELECT * FROM ledger_entries WHERE mine_id = ? ORDER BY id`, [mineId]),
    totals: db.all(`SELECT * FROM material_totals WHERE mine_id = ? ORDER BY material`, [mineId])
  })
  const tokens = (mineId: MineId): number =>
    Object.values(ledger.queries.totals(mineId)).reduce((sum, m) => sum + m.tokens, 0)
  const listed = (sortBy: 'name' | 'ore' = 'name') =>
    mines.queries
      .list({ sortBy, direction: sortBy === 'ore' ? 'desc' : 'asc' })
      .map((m) => m.mineId)
  const count = (table: 'mines' | 'dwarfs') =>
    Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.['n'])

  /**
   * A mine with ore, then removed: "Add a mine" on `name`, measured at `tier`, a session s1 that
   * spends `spent` tokens in it, then Remove mine, which ends s1.
   */
  const minedThenRemoved = async (name: string, spent: number, tier: LiveMaterial = 'silver') => {
    const cwd = await folder(name)
    const mineId = await addMine(cwd)
    measure(mineId, tier)
    const session = `${name}-s1`
    files.open(session, cwd, clock.now())
    files.spend(session, spent, clock.now() + 1)
    observation.control.start()
    await poll()
    await poll()
    // Credited once, before the removal: one ledger entry (ADR-006 item 9).
    expect(ledgerRows(mineId).entries).toHaveLength(1)
    const mapSite = mines.queries.get(mineId)?.mapSite
    const totals = ledger.queries.totals(mineId)
    const rows = ledgerRows(mineId)
    await remove(mineId)
    expect(mines.queries.get(mineId)).toBeNull()
    return { cwd, mineId, session, mapSite, totals, rows }
  }

  return {
    db,
    clock,
    bus,
    files,
    mines,
    crew,
    ledger,
    observation,
    walks,
    settle,
    poll,
    folder,
    addMine,
    measure,
    remove,
    ledgerRows,
    tokens,
    listed,
    count,
    minedThenRemoved
  }
}

describe('a removed mine returns with its ore (UC-006)', () => {
  it("[US-OBS-006.AC01, US-MINES-006.AC04, S3.20, INV-07, BR-05] a session observed in a removed mine's folder brings the same mine back working with the ore it had", async () => {
    const h = await host()
    const before = await h.minedThenRemoved('moria', 40_000, 'silver')
    const walksBefore = h.walks.length

    // A new session in the removed mine's folder, from the person's own terminal.
    h.files.open('s2', before.cwd, h.clock.now())
    await h.poll()

    // The same mine is back (S3.20: it was measured, so `active` with its last tier) …
    const back = h.mines.queries.get(before.mineId)
    expect(back).toMatchObject({ id: before.mineId, state: 'active', tier: 'silver' })
    expect(h.count('mines')).toBe(1)
    expect(h.bus.ofType('MineCreated').map((e) => e.payload.origin)).toEqual(['declared'])
    expect(h.bus.ofType('MineReattached').map((e) => e.payload)).toEqual([
      { mineId: before.mineId, via: 'rediscovery' }
    ])
    // … its re-measurement queued (TC-081-03) …
    expect(h.walks.slice(walksBefore)).toEqual([before.mineId])
    // … its dwarf working …
    expect(h.crew.queries.crewOf(before.mineId).map((d) => [d.rank, d.status])).toEqual([
      ['foreman', 'working']
    ])
    // … and the ore it had, not a fresh zero.
    expect(h.ledger.queries.totals(before.mineId)).toEqual(before.totals)
    expect(h.tokens(before.mineId)).toBe(40_000)
    h.observation.control.stop()
  })

  it("[US-OBS-006.AC02, US-MINES-006.AC05, S3.21] re-adding a removed mine's folder with Add a mine restores its previous ore", async () => {
    const h = await host()
    const before = await h.minedThenRemoved('moria', 25_000, 'gold')
    const walksBefore = h.walks.length

    const mineId = await h.addMine(before.cwd)

    expect(mineId).toBe(before.mineId)
    expect(h.count('mines')).toBe(1)
    expect(h.bus.ofType('MineReattached').map((e) => e.payload)).toEqual([
      { mineId: before.mineId, via: 'manual-add' }
    ])
    // It was measured, so it is back `active` with its last tier, and walked again.
    expect(h.mines.queries.get(mineId)).toMatchObject({ state: 'active', tier: 'gold' })
    expect(h.walks.slice(walksBefore)).toEqual([mineId])
    expect(h.ledger.queries.totals(mineId)).toEqual(before.totals)
    expect(h.tokens(mineId)).toBe(25_000)

    // A mine never measured comes back `measuring` (S3.21), with the ore it had all the same.
    const cwd = await h.folder('erebor')
    const unmeasured = await h.addMine(cwd)
    await h.remove(unmeasured)
    expect(await h.addMine(cwd)).toBe(unmeasured)
    expect(h.mines.queries.get(unmeasured)?.state).toBe('measuring')
    expect(h.tokens(unmeasured)).toBe(0)
    expect(h.count('mines')).toBe(2)
    h.observation.control.stop()
  })

  it('[US-OBS-006.AC03] a folder that was never a mine gets a new mine with no previous ore', async () => {
    const h = await host()
    const removed = await h.minedThenRemoved('moria', 40_000)

    const cwd = await h.folder('never-a-mine')
    h.files.open('s2', cwd, h.clock.now())
    await h.poll()

    // A new mine of its own (US-OBS-001/US-OBS-002 apply), nothing reattached …
    const created = h.bus.ofType('MineCreated').filter((e) => e.payload.origin === 'observed')
    expect(created).toHaveLength(1)
    const mineId = created[0]!.payload.mineId
    expect(mineId).not.toBe(removed.mineId)
    expect(h.bus.ofType('MineReattached')).toEqual([])
    // … with no previous ore to restore, while the removed mine stays removed with its own.
    expect(h.tokens(mineId)).toBe(0)
    expect(h.mines.queries.get(removed.mineId)).toBeNull()
    expect(h.tokens(removed.mineId)).toBe(40_000)
    h.observation.control.stop()
  })

  it("[US-MAP-004.AC04] the returning mine's marker is listed again and carries the retained totals", async () => {
    const h = await host()
    // A second mine with less ore, so the ore order shows where the returning mine's ore puts it.
    const other = await h.addMine(await h.folder('khazad'))
    h.measure(other, 'silver')
    const before = await h.minedThenRemoved('moria', 40_000, 'silver')
    expect(h.listed()).toEqual([other])

    h.files.open('s2', before.cwd, h.clock.now())
    await h.poll()

    // Listed again, on the same map site it had before removal …
    expect(h.listed()).toEqual([other, before.mineId].sort((a, b) => (a < b ? -1 : 1)))
    expect(h.mines.queries.get(before.mineId)?.mapSite).toEqual(before.mapSite)
    // … carrying the retained ore: it leads the ore order, and its totals are the ones it had.
    expect(h.listed('ore')).toEqual([before.mineId, other])
    expect(h.ledger.queries.totals(before.mineId)).toEqual(before.totals)
    h.observation.control.stop()
  })

  it('[S3.22] a late write of a session ended by the removal leaves the mine removed', async () => {
    const h = await host()
    const before = await h.minedThenRemoved('moria', 40_000)
    const arrived = h.bus.ofType('DwarfArrived').length

    // The session Remove mine ended flushes a late write, usage included, and so does a subagent
    // it ran, whose transcript is read here for the first time, in the removed mine's folder.
    h.files.say(before.session, 'dwarf', 'A late flush', h.clock.now())
    h.files.spend(before.session, 9_000, h.clock.now() + 1)
    const subagent = `${before.session}/agent-1`
    h.files.open(subagent, before.cwd, h.clock.now())
    h.files.spend(subagent, 7_000, h.clock.now() + 1)
    await h.poll()
    await h.poll()

    // Dropped: the ended session's own write by its departed dwarf (S4.40), the subagent's because
    // its session is in the ended ledger (INV-36). No SessionObserved, no rediscovery, no dwarf,
    // no ore.
    expect(
      h.bus.ofType('SessionObserved').map((e) => e.payload.identity.providerSessionId)
    ).toEqual([before.session])
    expect(h.mines.queries.get(before.mineId)).toBeNull()
    expect(h.listed()).toEqual([])
    expect(h.bus.ofType('MineReattached')).toEqual([])
    expect(h.bus.ofType('DwarfArrived')).toHaveLength(arrived)
    expect(h.tokens(before.mineId)).toBe(40_000)
    h.observation.control.stop()
  })

  it("[INV-96, NFR-PERS-08] the reattached mine's ledger entries are the same rows as before removal", async () => {
    const h = await host()
    const before = await h.minedThenRemoved('moria', 40_000)
    expect(before.rows.entries).toHaveLength(1)

    // Removal touched no ledger row …
    expect(h.ledgerRows(before.mineId)).toEqual(before.rows)

    // … and neither does the return, by rediscovery or by a later "Add a mine": no copy, no reset.
    h.files.open('s2', before.cwd, h.clock.now())
    await h.poll()
    expect(h.mines.queries.get(before.mineId)?.state).toBe('active')
    expect(h.ledgerRows(before.mineId)).toEqual(before.rows)
    expect(await h.addMine(before.cwd)).toBe(before.mineId)
    expect(h.ledgerRows(before.mineId)).toEqual(before.rows)
    expect(Number(h.db.all(`SELECT count(*) AS n FROM ledger_entries`)[0]?.['n'])).toBe(1)
    h.observation.control.stop()
  })
})
