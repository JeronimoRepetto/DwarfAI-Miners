// layer: L10
// L10 OS lane (17 §1.10 CH-01; ADR-015 items 3–5, 7; INV-56; UC-025): a Host that stops
// unexpectedly is followed by a new Host over the same database file on this OS, and the owned
// session carries on in the same dwarf.
//
// Host A is composed as host/main.ts composes the recovery's parts (crew and launching over a real
// database file migrated by the Host's own runner) and owns a real provider stand-in process,
// spawned through the kernel `NodeProcessControl` in its own process group as a launch spawns it.
// The injector stops Host A abruptly: its connection is dropped with nothing more written, no
// clean-shutdown marker, no end requested, and its provider process left running as a survivor.
// A `src/host` test cannot spawn or `kill -9` the built Host itself (R10, R17); killing the built
// Host is the E2E lane's (e2e/, 17 §1.9). Host B opens the same file, and its recovery pass probes
// the survivor on the real OS, ends it identity-checked (INV-56: never resumed while it runs), and
// resumes the session by its stored provider session id through a stub driver (SP-15: the id is
// kept), so the dwarf keeps its id and its custom name and nothing is reported.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { matchesRecorded, type ProcessIdentity } from './kernel/domain/processIdentity'
import type { DomainEvent } from './kernel/domain/domainEvent'
import type { HostEpoch, LaunchId, ProviderId } from './kernel/domain/values'
import { RecordingDiagnosticsLog } from './kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from './kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from './kernel/InProcessEventBus'
import { createCrew, rankForDepth, type CrewEvent } from './modules/crew'
import { createLaunching, type Launch, type LaunchingEvent } from './modules/launching'
import { launchRecording } from './modules/launching/testing/launchRecording'
import { ResumableDriver } from './modules/launching/testing/ResumableDriver'
import {
  MINE,
  MINE_FOLDER,
  seedMine,
  sqliteLaunchingStores
} from './modules/launching/testing/sqliteLaunchingDb'
import type { ProviderCapabilities } from './modules/suppliers'
import { NodeScheduler } from './platform/clock/NodeScheduler'
import { SystemClock } from './platform/clock/SystemClock'
import { NodeProcessControl } from './platform/process/NodeProcessControl'
import { NodeSqliteDatabase } from './platform/sqlite/NodeSqliteDatabase'
import { SqliteLifecycleFactLog } from './platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from './platform/sqlite/SqliteTransactionRunner'
import { buildTemplateDb } from './platform/sqlite/testing/templateDb.globalSetup'

const PROVIDER = 'claude' as ProviderId
const EPOCH_A = 'epoch-173-os-a' as HostEpoch
const EPOCH_B = 'epoch-173-os-b' as HostEpoch
const SESSION = 'session-173-os'
const CASE_TIMEOUT_MS = 60_000

const control = new NodeProcessControl()
const cleanups: Array<() => Promise<void> | void> = []
const started: ProcessIdentity[] = []

afterEach(async () => {
  for (const identity of started.splice(0)) {
    if (matchesRecorded(await control.probe(identity.pid), identity)) {
      try {
        process.kill(identity.pid, 'SIGKILL')
      } catch {
        // it ended meanwhile
      }
    }
  }
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One Host's composition over the database file at `path`: crew and launching, as main wires them. */
function hostOver(path: string, epoch: HostEpoch) {
  const db = NodeSqliteDatabase.open(path)
  const transactions = new SqliteTransactionRunner(db)
  const clock = new SystemClock()
  const scheduler = new NodeScheduler({ onTaskError: () => {} })
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const published: DomainEvent<string, unknown>[] = []
  const bus = new InProcessEventBus<CrewEvent | LaunchingEvent>({
    transactionScope: transactions,
    onHandlerError: () => {}
  })
  for (const type of ['DwarfDeparted', 'LaunchedSessionCrashed', 'HostRecovered'] as const) {
    bus.subscribe(type, (event) => published.push(event))
  }
  const crew = createCrew({
    db,
    transactions,
    lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: epoch,
    links: { owned: () => true, hasDeliveryRoute: () => false }
  })
  const { reports, ...stores } = sqliteLaunchingStores({ db, scope: transactions, clock, ids })
  const driver = new ResumableDriver({ providerId: PROVIDER, clock, scheduler, resumeMs: 10 })
  const launching = createLaunching({
    ...stores,
    transactions,
    starter: {
      start: () => {
        throw new Error('no launch in this lane')
      }
    },
    suppliers: {
      registry: { drivers: (id) => (id === PROVIDER ? [driver.driver] : []) },
      catalogue: { entry: () => null },
      bindings: { bind: () => undefined }
    },
    mines: { get: () => null, folderOf: () => MINE_FOLDER },
    crew: crew.commands,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch: epoch,
    installId: 'install-173-os',
    log
  })
  return { db, transactions, clock, ids, crew, stores, reports, driver, launching, published }
}

describe('Host crash recovery on this OS (CH-01)', () => {
  it(
    '[US-RES-009.AC01, SP-15] a killed Host restarts and the stub session carries on in the same dwarf',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'dwarfai-173-os-'))
      cleanups.push(() =>
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      )
      const template = buildTemplateDb()
      cleanups.push(() => rmSync(template.dir, { recursive: true, force: true }))

      // Host A owns one session: its provider process runs in its own process group (07 S4.01).
      const hostA = hostOver(template.path, EPOCH_A)
      seedMine(hostA.db, hostA.transactions)
      const child = control.spawn({
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        env: {},
        cwd: root,
        processGroup: 'own',
        stdio: 'ignore'
      })
      const survivor = await child.identity
      started.push(survivor)
      const dwarfId = hostA.crew.commands.arrive({
        mineId: MINE,
        identity: { providerId: PROVIDER, providerSessionId: SESSION },
        rank: rankForDepth(0),
        status: 'idle'
      })
      hostA.crew.commands.rename(dwarfId, 'Gimli the Bold')
      const launch: Launch = {
        id: hostA.ids.uuidv7() as LaunchId,
        request: {
          mineId: MINE,
          way: { kind: 'supplier', providerId: PROVIDER },
          prompt: 'Shore up the deep seam',
          jevOn: false,
          jevAutoAccept: false
        },
        state: 'resolving',
        hostEpoch: EPOCH_A,
        launchedWithLetJevChoose: false
      }
      const recording = launchRecording({
        ...hostA.stores,
        inTransaction: (work) => hostA.transactions.inTransaction(work)
      })
      const spawned = recording.spawned(recording.requested(launch), survivor, hostA.clock.now())
      recording.handshaken(spawned, dwarfId, {
        dwarfId,
        launchId: launch.id,
        ref: { providerId: PROVIDER, providerSessionId: SESSION },
        driverTransport: 'stream-json',
        cwd: root as never,
        launchOptions: { providerId: PROVIDER },
        launchedWithLetJevChoose: false,
        process: survivor,
        resumeIntent: true,
        stoppedByPerson: false,
        hostEpoch: EPOCH_A
      })

      // The injector: Host A stops abruptly. Its connection goes away with nothing more written
      // (no clean-shutdown marker, no end), and its provider process keeps running.
      hostA.db.close()
      expect(matchesRecorded(await control.probe(survivor.pid), survivor)).toBe(true)

      // Host B over the same file: the recovery pass of boot step 5, then its resume.
      const hostB = hostOver(template.path, EPOCH_B)
      cleanups.push(() => hostB.db.close())
      const recovery = hostB.launching.recovery({
        reports: hostB.reports,
        previousEpochEnd: () => ({ kind: 'crashed', rule: 'none' }),
        processControl: control,
        crew: {
          markUnrecovered: (id) => hostB.crew.commands.markUnrecovered(id),
          rebind: (id, next) => hostB.crew.commands.rebind(id, next),
          sessionClosed: (id, cause) => hostB.crew.commands.sessionClosed(id, cause),
          get: (id) => hostB.crew.queries.get(id)
        },
        // The terminator's owned end after a restart: the recorded tree, identity-checked.
        endSurvivor: () => control.killTree(survivor, { graceMs: 2_000, group: 'owned' }),
        catalogue: {
          capabilities: () =>
            ({ resume: 'cli-flag', adopt: false }) as unknown as ProviderCapabilities
        },
        deliveries: { reconcileSending: () => Promise.resolve(new Map()) }
      })
      const run = recovery.start()
      await run.classified
      // Classified before `ready`: the dwarf is in its mine and no provider was asked yet.
      expect(hostB.crew.queries.crewOf(MINE).map((d) => d.id)).toEqual([dwarfId])
      expect(hostB.driver.calls).toEqual([])
      const report = await run.settled

      // INV-56: the survivor was ended on the OS before its session was resumed.
      const deadline = Date.now() + 10_000
      while (matchesRecorded(await control.probe(survivor.pid), survivor)) {
        if (Date.now() > deadline) throw new Error('the survivor still runs')
        await sleep(100)
      }
      expect(hostB.driver.calls.map((c) => [c.op, c.providerSessionId])).toEqual([
        ['resume', SESSION]
      ])
      expect(report).toMatchObject({ resumed: [dwarfId], unrecovered: [] })
      expect(hostB.crew.queries.get(dwarfId)).toMatchObject({
        id: dwarfId,
        displayName: 'Gimli the Bold',
        processState: 'running',
        departed: false
      })
      expect(hostB.stores.records.live().map((r) => [r.dwarfId, r.hostEpoch])).toEqual([
        [dwarfId, EPOCH_B]
      ])
      expect(hostB.published.map((e) => e.type)).toEqual([])
    },
    CASE_TIMEOUT_MS
  )
})
