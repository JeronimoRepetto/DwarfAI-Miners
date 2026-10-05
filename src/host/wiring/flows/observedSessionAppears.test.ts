// layer: L2
// L2 flow (17 §1.2; 11 F1 "Observed session appears"; 12 UC-003, UC-004): observation, mines and
// crew composed through their public index.ts over one copy of the template database, with the
// 05 §4 routes declared here, as `host/wiring` will declare them (later: ISSUE-093…ISSUE-095):
//
// - `SessionObserved` → `mines.resolveForSession(cwd, firstMessage)` → `crew.arrive` on
//   `{ mineId }`; `{ waiting }` → nothing but the cursor (06 INV-39; AMENDMENT-2, SC-AR-01);
// - `SessionClosedObserved` → `crew.sessionClosed(…, 'closed-elsewhere')` (08 §2.3);
// - `TranscriptEntriesObserved` / `UsageObserved` reach conversation and ledger through the
//   `ObservedBatchSink` bridge inside the batch transaction (AMENDMENT-10): here a recording sink,
//   since conversation and ledger are not part of this flow.
//
// The sessions are the simulated provider's (`SimulatedObservationAdapter`); mine folders are real
// temp folders, because mines resolves a cwd on the real disk (ADR-030). The launched-fixture
// dwarf arrives through `crew.arrive` into an existing mine, as launching does after a launch.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, FolderPath, MineId, ProviderIdentity } from '../../kernel/domain/values'
import { ASLEEP_AFTER_MS, createCrew, type CrewEvent } from '../../modules/crew'
import { createMines, type MinesEvent } from '../../modules/mines'
import {
  OBSERVATION_POLL_MS,
  createObservation,
  createSqliteObservationStores,
  observedTransition,
  type ObservationEvent,
  type ObservedBatchSink
} from '../../modules/observation'
import {
  SimulatedObservationAdapter,
  SimulatedSessionLog
} from '../../modules/observation/adapters/simulated/SimulatedObservationAdapter'
import { NodeFs } from '../../platform/fs/NodeFs'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { toDwarfWire } from '../../transport/mappers/wire'

type HostEvent = ObservationEvent | MinesEvent | CrewEvent

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-0070'
const SIMULATED = 'simulated'
const identityOf = (sessionId: string): ProviderIdentity => ({
  providerId: SIMULATED,
  providerSessionId: sessionId
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** The composed Host slice over a template copy, with the 05 §4 routes of this flow. */
async function host() {
  const root = await mkdtemp(join(tmpdir(), 'dwarfai-observed-'))
  roots.push(root)
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const bus = new RecordingEventBus<HostEvent>({ transactionScope: transactions })
  const fs = new NodeFs()

  const mines = createMines({
    db,
    transactions,
    mapSites: [{ xPct: 10, yPct: 20 }],
    random: () => 0,
    fs,
    clock,
    ids,
    bus,
    hostEpoch: EPOCH,
    remeasure: () => undefined
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

  const sessions = new SimulatedSessionLog()
  const stores = createSqliteObservationStores({ db, scope: transactions, clock })
  const written: Array<Parameters<ObservedBatchSink['apply']>[0]> = []
  const sink: ObservedBatchSink = { apply: (batch) => void written.push(structuredClone(batch)) }
  const observe = () =>
    createObservation({
      adapters: [new SimulatedObservationAdapter({ providerId: SIMULATED, log: sessions })],
      fs,
      ...stores,
      sink,
      transactions,
      bus,
      clock,
      scheduler,
      ids,
      hostEpoch: EPOCH,
      log: new RecordingDiagnosticsLog()
    })
  let observation = observe()

  // The 05 §4 routes of this flow.
  const routes = new Set<Promise<void>>()
  const resolutions: Array<{ waiting?: true; created?: boolean }> = []
  bus.subscribe('SessionObserved', ({ payload }) => {
    const route = (async () => {
      const firstMessage = payload.firstMessage ?? false
      const resolved = await mines.commands.resolveForSession(payload.cwd, firstMessage)
      resolutions.push(resolved)
      if (!('mineId' in resolved)) return
      crew.commands.arrive({
        mineId: resolved.mineId,
        identity: payload.identity,
        rank: 'foreman',
        status: firstMessage ? 'working' : 'idle'
      })
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
    const path = join(root, name)
    await mkdir(path, { recursive: true })
    return path as FolderPath
  }
  const count = (table: 'mines' | 'dwarfs') =>
    Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.['n'])
  const dwarfOf = (sessionId: string): DwarfId | null =>
    (db.all(
      `SELECT id FROM dwarfs WHERE provider_id = ? AND provider_session_id = ? AND provider_agent_id = ''`,
      [SIMULATED, sessionId]
    )[0]?.['id'] as DwarfId | undefined) ?? null
  const mineOf = async (cwd: FolderPath): Promise<MineId> => {
    const declared = await mines.commands.declare(cwd)
    if (!declared.ok || !('mineId' in declared.value))
      throw new Error('the fixture mine was refused')
    return declared.value.mineId
  }
  /** What the person types and what the dwarf replies, in the simulated session. */
  const say = (sessionId: string, text: string) =>
    sessions.message(sessionId, 'person', text, clock.now())
  return {
    db,
    clock,
    bus,
    mines,
    crew,
    sessions,
    stores,
    written,
    resolutions,
    get observation() {
      return observation
    },
    /** A Host exit and a new Host over the same database (S4.37). */
    restartObservation() {
      observation.control.stop()
      observation = observe()
    },
    settle,
    poll,
    folder,
    count,
    dwarfOf,
    mineOf,
    say
  }
}

describe('observed session appears (F1)', () => {
  it('[US-OBS-001.AC01, US-MAP-004.AC05, INV-39] a session in a never-seen folder with no message makes no mine, no marker and no dwarf', async () => {
    const h = await host()
    const cwd = await h.folder('never-seen')
    h.sessions.open('s1', cwd, T0)

    h.observation.control.start()
    await h.settle()

    expect(h.bus.ofType('SessionObserved').map((e) => e.payload.firstMessage)).toEqual([false])
    expect(h.resolutions).toEqual([{ waiting: true }])
    // No mine, so no marker on the map, and no dwarf …
    expect(h.count('mines')).toBe(0)
    expect(h.bus.ofType('MineCreated')).toEqual([])
    expect(h.count('dwarfs')).toBe(0)
    // … only the cursor moved.
    expect(h.stores.cursors.get('simulated:s1')?.value).toBe(1)
    h.observation.control.stop()
  })

  it('[US-OBS-001.AC02, US-MAP-004.AC06, S3.01] its first message creates the mine and one working dwarf at once', async () => {
    const h = await host()
    const cwd = await h.folder('never-seen')
    h.sessions.open('s1', cwd, T0)
    h.observation.control.start()
    await h.settle()
    expect(h.count('mines')).toBe(0)

    h.say('s1', 'Dig the north seam')
    await h.poll()

    // The mine and its marker exist from that moment (S3.01: `unrecorded`, origin observed) …
    const created = h.bus.ofType('MineCreated')
    expect(created.map((e) => e.payload.origin)).toEqual(['observed'])
    const mine = h.mines.queries.get(created[0]!.payload.mineId)
    expect(mine?.state).toBe('unrecorded')
    expect(mine?.mapSite).toEqual({ xPct: 10, yPct: 20 })
    // … with its one dwarf, already working, without any add step.
    const dwarfs = h.crew.queries.crewOf(mine!.id)
    expect(dwarfs.map((d) => [d.rank, d.status])).toEqual([['foreman', 'working']])
    expect(h.bus.ofType('DwarfArrived')).toHaveLength(1)

    // The held message is written to that dwarf at the next cycle, and the cursor passes it.
    await h.poll()
    expect(h.written.map((b) => [b.dwarfId, b.entries.map((e) => e.text)])).toEqual([
      [dwarfs[0]!.id, ['Dig the north seam']]
    ])
    expect(h.stores.cursors.get('simulated:s1')?.value).toBe(2)
    expect(h.observation.queries.observedSessionOf(dwarfs[0]!.id)?.streamIds).toEqual([
      'simulated:s1'
    ])
    h.observation.control.stop()
  })

  it('[US-OBS-002.AC08] in a folder that is not a mine the arrival waits for the first message', async () => {
    const h = await host()
    await h.mineOf(await h.folder('a-mine'))
    const cwd = await h.folder('not-a-mine')
    h.sessions.open('s1', cwd, T0)
    h.sessions.activity('s1', T0 + 1)
    h.observation.control.start()
    await h.settle()
    await h.poll()

    // US-OBS-001 governs: nothing appears for that folder until the first message.
    expect(h.dwarfOf('s1')).toBeNull()
    expect(h.bus.ofType('DwarfArrived')).toEqual([])
    expect(h.count('mines')).toBe(1)

    h.say('s1', 'Hello')
    await h.poll()
    expect(h.dwarfOf('s1')).not.toBeNull()
    expect(h.count('mines')).toBe(2)
    h.observation.control.stop()
  })

  it('[US-MAP-004.AC07] a new session in an existing mine adds a dwarf and creates or moves no marker', async () => {
    const h = await host()
    const cwd = await h.folder('moria')
    const mineId = await h.mineOf(cwd)
    const before = h.mines.queries.get(mineId)
    const minesEvents = () =>
      h.bus.published.filter((e) => e.type === 'MineCreated' || e.type === 'MineReattached')
    const markersBefore = minesEvents().length

    h.sessions.open('s1', cwd, T0)
    h.observation.control.start()
    await h.settle()

    // The dwarf appears at once, before any message, idle (UC-004).
    const dwarfs = h.crew.queries.crewOf(mineId)
    expect(dwarfs.map((d) => [d.rank, d.status])).toEqual([['foreman', 'idle']])
    // The mine already had its marker: none created, none moved.
    expect(minesEvents()).toHaveLength(markersBefore)
    expect(h.count('mines')).toBe(1)
    expect(h.mines.queries.get(mineId)?.mapSite).toEqual(before?.mapSite)
    h.observation.control.stop()
  })

  it('[US-OBS-007.AC01, US-OBS-007.AC02, INV-30] a launched-fixture dwarf and an observed dwarf produce identical DwarfWire fields apart from ids and follow the same status and departure rules', async () => {
    const h = await host()
    const cwd = await h.folder('moria')
    const mineId = await h.mineOf(cwd)
    // The launched fixture: launching's arrival after a launch into an existing mine.
    const launched = h.crew.commands.arrive({
      mineId,
      identity: identityOf('launched-1'),
      rank: 'foreman',
      status: 'idle'
    })
    h.sessions.open('observed-1', cwd, T0)
    h.observation.control.start()
    await h.settle()
    const observed = h.dwarfOf('observed-1')!

    // Nothing in the wire says which way either came to exist: equal apart from the ids (the id
    // and the base name, which is derived from the provider identity).
    const wireOf = (id: DwarfId) => {
      const { id: _id, baseName: _name, ...rest } = toDwarfWire(h.crew.queries.get(id)!)
      return rest
    }
    expect(wireOf(observed)).toEqual(wireOf(launched))

    // The same status rule: both fall asleep after the same 60 s of nothing (ADR-032).
    h.observation.control.stop()
    h.clock.advance(ASLEEP_AFTER_MS)
    expect([h.crew.queries.get(launched)?.status, h.crew.queries.get(observed)?.status]).toEqual([
      'asleep',
      'asleep'
    ])
    expect(wireOf(observed)).toEqual(wireOf(launched))

    // The same departure path: the one `sessionClosed`, whatever reported the end.
    h.crew.commands.sessionClosed(launched, 'closed-elsewhere')
    h.sessions.close('observed-1', h.clock.now())
    h.observation.control.start()
    await h.settle()
    const departed = h.bus.ofType('DwarfDeparted').map((e) => [e.payload.dwarfId, e.payload.cause])
    expect(departed).toEqual([
      [launched, 'closed-elsewhere'],
      [observed, 'closed-elsewhere']
    ])
    h.observation.control.stop()
  })

  it('[US-OBS-007.AC06] an observed session can create a mine while a launch needs an existing one', async () => {
    const h = await host()
    const cwd = await h.folder('brand-new')
    h.sessions.open('s1', cwd, T0)
    h.say('s1', 'Start here')
    h.observation.control.start()
    await h.settle()
    // The observed session brought its mine into being.
    expect(h.count('mines')).toBe(1)
    expect(h.dwarfOf('s1')).not.toBeNull()

    // A launch aims at a mine: an arrival into a mine that does not exist is refused, nothing made.
    const nowhere = '00000000-0000-7000-8000-00000000dead' as MineId
    expect(() =>
      h.crew.commands.arrive({
        mineId: nowhere,
        identity: identityOf('launched-1'),
        rank: 'foreman',
        status: 'working'
      })
    ).toThrow()
    expect(h.dwarfOf('launched-1')).toBeNull()
    expect(h.count('mines')).toBe(1)
    h.observation.control.stop()
  })

  it('[S4.30, S4.31, S4.32, S4.33, S4.34, S4.35, S4.36, S4.37, S4.40, S4.41] every observed-session transition reaches its derived state over the composed flow: a new identity arrives, an owned identity adds no dwarf, activity keeps it active, a close elsewhere or an ended stop closes it, a failed stop keeps it active, a Host exit makes it unobserved, a late write of an ended identity changes nothing, and a resumed or forked session is a new dwarf; a transition 07 does not list is rejected', async () => {
    const h = await host()
    const cwd = await h.folder('moria')
    const mineId = await h.mineOf(cwd)
    const step = (...args: Parameters<typeof observedTransition>) => {
      const result = observedTransition(...args)
      return result.ok ? [result.value.id, result.value.to] : result.error
    }
    const closedAt = (sessionId: string) =>
      h.stores.sessions.byIdentity(identityOf(sessionId))?.closedAt ?? null
    const writtenTo = (dwarfId: DwarfId | null) =>
      h.written.filter((b) => b.dwarfId === dwarfId).flatMap((b) => b.entries.map((e) => e.text))
    h.observation.control.start()

    // S4.30: a new identity, not ended → active, a new dwarf.
    expect(step('[*]', { type: 'observed' })).toEqual(['S4.30', 'active'])
    h.sessions.open('w1', cwd, T0)
    await h.poll()
    const w1 = h.dwarfOf('w1')
    expect(w1).not.toBeNull()
    expect(closedAt('w1')).toBeNull()

    // S4.31: the identity of a session DwarfAI launched → the same dwarf, no new one.
    expect(step('[*]', { type: 'observed-owned' })).toEqual(['S4.31', 'active'])
    const owned = h.crew.commands.arrive({
      mineId,
      identity: identityOf('owned-1'),
      rank: 'foreman',
      status: 'working'
    })
    const dwarfsBefore = h.count('dwarfs')
    h.sessions.open('owned-1', cwd, h.clock.now())
    h.say('owned-1', 'Seen through the transcript too')
    await h.poll()
    expect(h.count('dwarfs')).toBe(dwarfsBefore)
    expect(writtenTo(owned)).toEqual(['Seen through the transcript too'])

    // S4.32: records keep it active, routed on.
    expect(step('active', { type: 'records' })).toEqual(['S4.32', 'active'])
    h.sessions.activity('w1', h.clock.now(), true)
    h.say('w1', 'Keep digging')
    await h.poll()
    expect(writtenTo(w1)).toEqual(['Keep digging'])
    expect(h.bus.ofType('SessionActivityObserved').length).toBeGreaterThan(0)
    expect(h.crew.queries.get(w1!)?.departed).toBe(false)

    // S4.33: closed elsewhere → closed, the dwarf leaves `closed-elsewhere`.
    expect(step('active', { type: 'closed-elsewhere' })).toEqual(['S4.33', 'closed'])
    h.sessions.close('w1', h.clock.now())
    await h.poll()
    expect(closedAt('w1')).not.toBeNull()
    expect(h.bus.ofType('DwarfDeparted').map((e) => [e.payload.dwarfId, e.payload.cause])).toEqual([
      [w1, 'closed-elsewhere']
    ])

    // S4.34 → S4.35: a stop that ended it → closed (the terminator's exit route departs it).
    expect(step('active', { type: 'stop' })).toEqual(['S4.34', 'ending'])
    expect(step('ending', { type: 'end-outcome', ended: true })).toEqual(['S4.35', 'closed'])
    h.sessions.open('w2', cwd, h.clock.now())
    await h.poll()
    const w2 = h.dwarfOf('w2')!
    h.crew.commands.sessionClosed(w2, 'stopped')
    expect(closedAt('w2')).not.toBeNull()

    // S4.40: a late write of the ended identity changes nothing: no dwarf, no message, no event.
    expect(step('closed', { type: 'records' })).toEqual(['S4.40', 'closed'])
    const observedBefore = h.bus.ofType('SessionObserved').length
    const dwarfsNow = h.count('dwarfs')
    h.say('w2', 'A late flush')
    await h.poll()
    expect(writtenTo(w2)).toEqual([])
    expect(h.count('dwarfs')).toBe(dwarfsNow)
    expect(h.bus.ofType('SessionObserved')).toHaveLength(observedBefore)
    expect(h.bus.ofType('DwarfDeparted')).toHaveLength(2)

    // S4.36: a stop that could not end it → still active, its records still arrive.
    expect(step('ending', { type: 'end-outcome', ended: false })).toEqual(['S4.36', 'active'])
    h.sessions.open('w3', cwd, h.clock.now())
    await h.poll()
    const w3 = h.dwarfOf('w3')!
    h.say('w3', 'Still here')
    await h.poll()
    expect(writtenTo(w3)).toEqual(['Still here'])
    expect(closedAt('w3')).toBeNull()

    // S4.37: the Host exits → unobserved: nothing is read while no Host runs …
    expect(step('active', { type: 'host-exit' })).toEqual(['S4.37', 'unobserved'])
    h.observation.control.stop()
    h.say('w3', 'While no Host ran')
    await h.poll()
    expect(writtenTo(w3)).toEqual(['Still here'])
    // … and the next Host reads on from the stored cursor, once.
    h.restartObservation()
    h.observation.control.start()
    await h.settle()
    expect(writtenTo(w3)).toEqual(['Still here', 'While no Host ran'])

    // S4.41: the person resumes or forks w1 in their own terminal under a new id → a new dwarf.
    expect(step('[*]', { type: 'resumed-elsewhere' })).toEqual(['S4.41', 'active'])
    h.sessions.open('w1-resumed', cwd, h.clock.now())
    await h.poll()
    const resumed = h.dwarfOf('w1-resumed')
    expect(resumed).not.toBeNull()
    expect(resumed).not.toBe(w1)

    // A transition 07 does not list is rejected, never guessed.
    expect(step('closed', { type: 'stop' })).toBe('not-a-transition')
    expect(step('closed', { type: 'closed-elsewhere' })).toBe('not-a-transition')
    expect(step('unobserved', { type: 'records' })).toBe('not-a-transition')
    expect(step('ending', { type: 'records' })).toBe('not-a-transition')
    h.observation.control.stop()
  })
})
