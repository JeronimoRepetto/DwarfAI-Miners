// layer: L2
// L2 flow (17 §1.2; 12 UC-032 "A mine's folder is moved or deleted while its dwarfs work"; 13
// FM-095): observation, mines and crew composed through their public index.ts over one copy of the
// template database, with the 05 §4 routes of this flow declared here, as `host/wiring` will
// declare them (later: ISSUE-093…ISSUE-095):
//
// - `SessionObserved` → `mines.resolveForSession(cwd, firstMessage)` → `crew.arrive` on `{ mineId }`;
// - `SessionClosedObserved` → `crew.sessionClosed(…, 'closed-elsewhere')` (08 §2.3; S2.06);
// - `ProviderErrorObserved` → the transport's `toast {kind: 'provider-error'}` (14 §2.4 B-F28) and
//   `mines.checkFolder` for that dwarf's mine (05 §4; AMENDMENT-2 SC-AR-04). Observation publishes
//   the event from its adapters' failures with ISSUE-084, so the event is published here as it will
//   be, with 08 §0's payload, and the toast frame is recorded as the transport sends it;
// - the mines' folder-check schedule, every `MINE_FOLDER_CHECK_MS` for mines with a present dwarf.
//
// Mine folders are real temp folders, because mines resolves a cwd and checks a folder on the real
// disk; the sessions are the simulated provider's.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostToast } from '@dwarfai/contracts'
import type { DomainEvent } from '../../kernel/domain/domainEvent'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, EventId, FolderPath, MineId } from '../../kernel/domain/values'
import { createCrew, type CrewEvent } from '../../modules/crew'
import { MINE_FOLDER_CHECK_MS, createMines, type MinesEvent } from '../../modules/mines'
import {
  OBSERVATION_POLL_MS,
  createObservation,
  createSqliteObservationStores,
  type ObservationEvent
} from '../../modules/observation'
import {
  SimulatedObservationAdapter,
  SimulatedSessionLog
} from '../../modules/observation/adapters/simulated/SimulatedObservationAdapter'
import { NodeFs } from '../../platform/fs/NodeFs'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'

/** 08 §0 `ProviderErrorObserved` (observation, ISSUE-084): a provider's failure for a dwarf. */
type ProviderErrorObserved = DomainEvent<
  'ProviderErrorObserved',
  { providerId: string; cause: string; dwarfId?: DwarfId }
>

type HostEvent = ObservationEvent | MinesEvent | CrewEvent | ProviderErrorObserved

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-0085'
const SIMULATED = 'simulated'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** The composed Host slice over a template copy, with the 05 §4 routes of this flow. */
async function host() {
  const root = await mkdtemp(join(tmpdir(), 'dwarfai-folder-gone-'))
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
  const observation = createObservation({
    adapters: [new SimulatedObservationAdapter({ providerId: SIMULATED, log: sessions })],
    fs,
    ...stores,
    sink: { apply: () => undefined },
    transactions,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    log: new RecordingDiagnosticsLog()
  })
  const folderChecks = mines.folderCheckSchedule({ scheduler, intervalMs: MINE_FOLDER_CHECK_MS })

  // The 05 §4 routes of this flow.
  const routes = new Set<Promise<unknown>>()
  const track = (route: Promise<unknown>) => {
    routes.add(route)
    void route.finally(() => routes.delete(route))
  }
  /** The `toast` frames the transport sends (14 §2.4 B-F28), in order. */
  const toasts: HostToast[] = []
  bus.subscribe('SessionObserved', ({ payload }) => {
    track(
      (async () => {
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
    )
  })
  bus.subscribe('SessionClosedObserved', ({ payload }) => {
    const dwarfId = stores.sessions.byIdentity(payload.identity)?.dwarfId
    if (dwarfId !== undefined) crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')
  })
  bus.subscribe('ProviderErrorObserved', ({ payload }) => {
    const { providerId, cause, dwarfId } = payload
    toasts.push({
      kind: 'provider-error',
      providerId,
      cause,
      ...(dwarfId === undefined ? {} : { dwarfId })
    } as HostToast)
    const mineId = dwarfId === undefined ? undefined : crew.queries.get(dwarfId)?.mineId
    if (mineId !== undefined) track(mines.commands.checkFolder(mineId))
  })

  /** Every cycle and every route it caused has settled. */
  const settle = async () => {
    for (let n = 0; n < 10; n++) {
      await observation.whenIdle()
      await folderChecks.idle()
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
  /** The person moves the folder away: here, deletes it. */
  const removeFolder = (path: FolderPath) => rm(path, { recursive: true, force: true })
  /** A dwarf working in `cwd`: its session's first message makes the mine (S3.01) and the dwarf. */
  const working = async (sessionId: string, cwd: FolderPath): Promise<DwarfId> => {
    sessions.open(sessionId, cwd, clock.now())
    sessions.message(sessionId, 'person', 'Dig the north seam', clock.now())
    await poll()
    const dwarfId = stores.sessions.byIdentity({
      providerId: SIMULATED,
      providerSessionId: sessionId
    })?.dwarfId
    if (dwarfId === undefined) throw new Error(`no dwarf arrived for ${sessionId}`)
    return dwarfId
  }
  /** The provider of `dwarfId` fails (FM-067), as observation reports it (ISSUE-084). */
  const providerFails = (dwarfId: DwarfId) => {
    bus.publish({
      type: 'ProviderErrorObserved',
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch: EPOCH,
      payload: { providerId: SIMULATED, cause: 'provider-error', dwarfId }
    })
  }
  const mineOf = (dwarfId: DwarfId): MineId => {
    const mineId = crew.queries.get(dwarfId)?.mineId
    if (mineId === undefined) throw new Error(`no dwarf ${dwarfId}`)
    return mineId
  }
  const departures = () =>
    bus.ofType('DwarfDeparted').map((event) => [event.payload.dwarfId, event.payload.cause])
  const count = (table: 'mines' | 'dwarfs') =>
    Number(db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.['n'])
  return {
    clock,
    bus,
    mines,
    crew,
    sessions,
    observation,
    folderChecks,
    toasts,
    settle,
    poll,
    folder,
    removeFolder,
    working,
    providerFails,
    mineOf,
    departures,
    count
  }
}

describe('a mine folder moves or disappears while its dwarfs work (UC-032)', () => {
  it('[US-RES-007.AC01] a dwarf failing because its folder moved produces the ordinary provider-error toast', async () => {
    const h = await host()
    const gone = await h.folder('old-shaft')
    const intact = await h.folder('north-seam')
    h.observation.control.start()
    const lost = await h.working('s-lost', gone)
    const other = await h.working('s-other', intact)

    await h.removeFolder(gone)
    h.providerFails(lost)
    h.providerFails(other)
    await h.settle()

    // The same toast, worded no differently from provider trouble in a mine whose folder is there.
    expect(h.toasts).toEqual([
      { kind: 'provider-error', providerId: SIMULATED, cause: 'provider-error', dwarfId: lost },
      { kind: 'provider-error', providerId: SIMULATED, cause: 'provider-error', dwarfId: other }
    ])
    // The error route checked each dwarf's mine: only the one whose folder is gone changed.
    expect(h.mines.queries.get(h.mineOf(lost))).toMatchObject({
      state: 'unenterable',
      unenterableReason: 'not-found'
    })
    expect(h.mines.queries.get(h.mineOf(other))?.state).toBe('unrecorded')
    expect(h.bus.ofType('MineBecameUnenterable').map((event) => event.payload)).toEqual([
      { mineId: h.mineOf(lost), reason: 'not-found' }
    ])
    // The dwarf keeps its status: there is no "errored" state, and it is still present.
    expect(h.crew.queries.get(lost)).toMatchObject({ departed: false, status: 'working' })
    h.observation.control.stop()
  })

  it('[US-RES-007.AC02, S2.06] a dwarf whose session ends because its folder is gone departs closed-elsewhere', async () => {
    const h = await host()
    const gone = await h.folder('old-shaft')
    h.observation.control.start()
    const dwarf = await h.working('s1', gone)
    const mineId = h.mineOf(dwarf)
    h.folderChecks.start()

    await h.removeFolder(gone)
    // The folder-check schedule finds it gone while its dwarf is present (S3.12 trigger (c)).
    h.clock.advance(MINE_FOLDER_CHECK_MS)
    await h.settle()
    expect(h.mines.queries.get(mineId)?.state).toBe('unenterable')

    // The session cannot continue and its process ends: the ordinary departure, as any cause.
    h.sessions.close('s1', h.clock.now())
    await h.poll()
    expect(h.departures()).toEqual([[dwarf, 'closed-elsewhere']])
    // The mine is never removed on its own: it stays, not enterable, with its row and its ledger.
    expect(h.mines.queries.get(mineId)).toMatchObject({ state: 'unenterable', presentDwarfs: 0 })
    expect(h.count('mines')).toBe(1)
    expect(h.bus.ofType('MineBecameUnenterable')).toHaveLength(1)
    h.folderChecks.stop()
    h.observation.control.stop()
  })

  it('[US-RES-007.AC06, FM-095] several dwarfs of that mine each get their own toast and their own departure', async () => {
    const h = await host()
    const gone = await h.folder('old-shaft')
    h.observation.control.start()
    const first = await h.working('s1', gone)
    const second = await h.working('s2', gone)
    const mineId = h.mineOf(first)
    expect(h.mineOf(second)).toBe(mineId)

    await h.removeFolder(gone)
    h.providerFails(first)
    h.providerFails(second)
    await h.settle()
    h.sessions.close('s1', h.clock.now())
    h.sessions.close('s2', h.clock.now())
    await h.poll()

    // One toast per dwarf, never folded into one combined notice …
    expect(h.toasts.map((toast) => toast.kind === 'provider-error' && toast.dwarfId)).toEqual([
      first,
      second
    ])
    // … one ordinary departure per dwarf …
    expect(h.departures()).toEqual([
      [first, 'closed-elsewhere'],
      [second, 'closed-elsewhere']
    ])
    // … and the mine changed once, however many dwarfs reported the folder gone.
    expect(h.bus.ofType('MineBecameUnenterable').map((event) => event.payload.mineId)).toEqual([
      mineId
    ])
    expect(h.mines.queries.get(mineId)?.state).toBe('unenterable')
    h.observation.control.stop()
  })
})
