import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@dwarfai/contracts'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { migrationsFor } from '../../platform/sqlite/migrations'
import { defineMigration, type Migration } from '../../platform/sqlite/migrations/types'
import { NodeSqliteDatabase } from '../../platform/sqlite/NodeSqliteDatabase'
import { UI_TOKEN_FILE, UiToken } from '../../transport/auth/uiToken'
import { collectCapabilities } from '../../transport/capabilities'
import { acceptConnection } from '../../transport/connection'
import { ConnectionRegistry } from '../../transport/connectionRegistry'
import { Dispatcher } from '../../transport/dispatcher'
import { createCleanExit } from '../../transport/lifecycle/cleanExit'
import { HostStateHolder, LIFECYCLE_FRAMES } from '../../transport/lifecycle/hostState'
import { FrameClient } from '../../transport/testing/frameClient'
import { inProcessDuplex } from '../../transport/testing/inProcessDuplex'
import { runBoot, type BootOutcome, type HostStateReport } from '../boot'
import { createBootSteps, mintBootEpoch } from '../bootSteps'
import { BOOT_FAILED_EXIT_CODE } from '../exitCodes'
import { createHostDatabase, HOST_DB_FILE, type HostDatabase } from '../hostDatabase'
import { HelloThrottle } from '../../transport/auth/throttle'

// L2 flow (17 §1.2): boot step 2 of 16 §8.2 over a real database file in a temp directory, with a
// FakeClock, a FakeProcessControl boot identity and the other ports faked. A Host killed or
// stopped is CH-01 (17 §1.10): the composition is built again over the same file.

const T0 = 1_790_000_000_000
const HOUR_MS = 3_600_000

/** A migration this build does not know: a file a newer build migrated (ADR-005 item 5). */
const FUTURE: Migration = defineMigration({
  version: 2,
  name: '0002-from-a-newer-build',
  sql: 'CREATE TABLE from_a_newer_build (id INTEGER NOT NULL PRIMARY KEY) STRICT;'
})

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** The machine the Hosts of one case run on: one data directory, one clock, one OS. */
function machine() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dwarfai-039-boot-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const clock = new FakeClock(T0)
  const processControl = new FakeProcessControl({ bootId: 'boot-one', clock })
  processControl.scriptBootIdentity({ bootTimeMs: T0 - HOUR_MS, logonSessionId: 'logon-one' })
  // One id sequence for every Host of the case, so each boot mints a new epoch.
  const ids = new SequenceIdGenerator()
  return { dataDir, path: join(dataDir, HOST_DB_FILE), clock, processControl, ids }
}

type Machine = ReturnType<typeof machine>

interface BootedHost {
  outcome: BootOutcome
  epoch: string
  database: HostDatabase
  log: RecordingDiagnosticsLog
  states: Array<HostStateReport['state']>
  exits: number[]
}

/** One Host start on `m`: the real step list, step 2 over the real database file. */
async function bootHost(m: Machine, migrations?: readonly Migration[]): Promise<BootedHost> {
  const log = new RecordingDiagnosticsLog()
  const states: Array<HostStateReport['state']> = []
  const exits: number[] = []
  const epoch = mintBootEpoch(m.ids)
  const database = createHostDatabase({
    path: m.path,
    epoch,
    clock: m.clock,
    log,
    processControl: m.processControl,
    open: {
      buildKind: 'test',
      releaseDataDir: join(m.dataDir, 'release-data'),
      appVersion: '0.0.0-test',
      migrations: migrations ?? migrationsFor({ clock: m.clock, ids: m.ids })
    }
  })
  cleanups.push(() => database.close())
  const outcome = await runBoot(
    (paths) =>
      createBootSteps({
        paths,
        clock: m.clock,
        scheduler: new FakeScheduler(m.clock),
        ids: m.ids,
        fs: new FakeFs(),
        processControl: m.processControl,
        log,
        endpoint: { bind: () => Promise.resolve('bound'), close: () => Promise.resolve() },
        database
      }),
    {
      log,
      clock: m.clock,
      state: { report: (report) => states.push(report.state) },
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: m.dataDir }) },
      runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
      exit: (code) => exits.push(code)
    }
  )
  return { outcome, epoch, database, log, states, exits }
}

/** Reads the file as the next Host would, after every connection of the case was closed. */
function readFile<T>(path: string, read: (db: SqliteDatabase) => T): T {
  const db = NodeSqliteDatabase.open(path)
  try {
    return read(db)
  } finally {
    db.close()
  }
}

function appMeta(path: string): Record<string, unknown> {
  return readFile(path, (db) => ({ ...db.all('SELECT * FROM app_meta WHERE id = 1')[0] }))
}

/** The boot identity values of the case, which no record may carry (09 §8.4; 19 §9.1). */
function expectNoIdentityValues(log: RecordingDiagnosticsLog): void {
  const written = JSON.stringify(log.entries)
  for (const value of ['boot-one', 'boot-two', 'logon-one', 'logon-two', String(T0 - HOUR_MS)]) {
    expect(written).not.toContain(value)
  }
}

describe('boot step 2: open the database and keep the Host epoch (09 §8.4, 16 §8.2)', () => {
  it('[S12.05, ADR-005] a first boot reports migrating, applies migration 1 and then reports ready', async () => {
    const m = machine()

    const host = await bootHost(m)

    expect(host.outcome).toEqual({ kind: 'ready' })
    expect(host.states).toEqual(['starting', 'migrating', 'starting', 'ready'])
    expect(host.log.byEvent('host.migrating')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'host' })
    ])
    expect(host.log.byEvent('host.boot.step')[1]).toEqual(
      expect.objectContaining({ causeClass: 'open-db-and-migrate', outcome: 'ok' })
    )
    // A first boot has no previous epoch: nothing to decide, nothing logged about it.
    expect(host.database.previousEpochEnd()).toBeNull()
    expect(host.log.byEvent('host.boot.unclean')).toEqual([])
    expect(host.log.byEvent('host.boot.rebooted')).toEqual([])
    // The snapshot meta section's reset epoch reads app_meta (lead decision 2026-09-30).
    expect(host.database.resetEpoch()).toBe(0)
    host.database.close()
    expect(readFile(m.path, (db) => db.all('SELECT version FROM schema_migrations'))).toEqual([
      { version: 1 }
    ])
    expect(appMeta(m.path)).toMatchObject({
      current_host_epoch: host.epoch,
      host_epoch_started_at: T0,
      host_boot_id: 'boot-one',
      host_boot_time_ms: T0 - HOUR_MS,
      host_logon_session_id: 'logon-one',
      clean_shutdown_epoch: null,
      clean_shutdown_reason: null
    })
  })

  it('[FM-001, CH-01] a Host killed without a marker and restarted under the same boot identity logs host.boot.unclean', async () => {
    const m = machine()
    const first = await bootHost(m)
    // The first Host had no previous epoch: only the restart reads one, never its own.
    expect(first.log.byEvent('host.boot.unclean')).toEqual([])
    // Killed: no checkpoint, no marker; only its connection goes with the process.
    first.database.close()
    m.clock.advance(5 * 60_000)

    const second = await bootHost(m)

    expect(second.outcome).toEqual({ kind: 'ready' })
    expect(second.states).toEqual(['starting', 'ready'])
    expect(second.database.previousEpochEnd()).toEqual({ kind: 'crashed', rule: 'none' })
    expect(second.log.byEvent('host.boot.unclean')).toEqual([
      expect.objectContaining({ level: 'warn', subsystem: 'host' })
    ])
    expect(second.log.byEvent('host.boot.rebooted')).toEqual([])
    expectNoIdentityValues(second.log)
    second.database.close()
    expect(appMeta(m.path)).toMatchObject({
      current_host_epoch: second.epoch,
      host_epoch_started_at: T0 + 5 * 60_000
    })
  })

  it('[FM-110] a restart under another bootId logs host.boot.rebooted with causeClass boot-id', async () => {
    const m = machine()
    const first = await bootHost(m)
    first.database.close()
    m.clock.advance(HOUR_MS)
    m.processControl.scriptBootIdentity({ bootId: 'boot-two', bootTimeMs: T0 + HOUR_MS - 30_000 })

    const second = await bootHost(m)

    expect(second.database.previousEpochEnd()).toEqual({ kind: 'rebooted', rule: 'boot-id' })
    expect(second.log.byEvent('host.boot.rebooted')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'host', causeClass: 'boot-id' })
    ])
    expect(second.log.byEvent('host.boot.unclean')).toEqual([])
    expectNoIdentityValues(second.log)
    second.database.close()
    expect(appMeta(m.path)).toMatchObject({
      current_host_epoch: second.epoch,
      host_boot_id: 'boot-two'
    })
  })

  it('[ADR-015, FM-110] a restart in another logon session, or with an unreadable bootId and a later boot time, logs host.boot.rebooted with its rule and never the values', async () => {
    const cases: ReadonlyArray<{
      after: Parameters<FakeProcessControl['scriptBootIdentity']>[0]
      causeClass: string
    }> = [
      { after: { logonSessionId: 'logon-two' }, causeClass: 'logon-session' },
      { after: { bootId: 'unknown', bootTimeMs: T0 + 90_000 }, causeClass: 'boot-time' }
    ]
    for (const { after, causeClass } of cases) {
      const m = machine()
      const first = await bootHost(m)
      first.database.close()
      m.clock.advance(HOUR_MS)
      m.processControl.scriptBootIdentity(after)

      const second = await bootHost(m)

      expect(second.log.byEvent('host.boot.rebooted'), causeClass).toEqual([
        expect.objectContaining({ level: 'info', subsystem: 'host', causeClass })
      ])
      expect(second.log.byEvent('host.boot.unclean'), causeClass).toEqual([])
      expectNoIdentityValues(second.log)
      second.database.close()
    }
  })

  it('[ADR-015, FM-110] when the OS boot identity cannot be read at all the boot is a crash and the case is logged degraded', async () => {
    const m = machine()
    const first = await bootHost(m)
    first.database.close()
    m.processControl.scriptBootIdentity({
      bootId: 'unknown',
      bootTimeMs: 'unknown',
      logonSessionId: 'unknown'
    })

    const second = await bootHost(m)

    expect(second.database.previousEpochEnd()).toEqual({
      kind: 'crashed',
      rule: 'none',
      degraded: true
    })
    expect(second.log.byEvent('host.boot.rebooted')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'host', outcome: 'degraded' })
    ])
    expect(second.log.byEvent('host.boot.unclean')).toEqual([
      expect.objectContaining({ level: 'warn' })
    ])
    second.database.close()
    expect(appMeta(m.path)).toMatchObject({
      current_host_epoch: second.epoch,
      host_boot_id: null,
      host_boot_time_ms: null,
      host_logon_session_id: null
    })
  })

  it('[ADR-005, FM-100] a newer database file boots read-only and hello.ok capabilities include db-read-only', async () => {
    const m = machine()
    const newer = await bootHost(m, [...migrationsFor({ clock: m.clock, ids: m.ids }), FUTURE])
    newer.database.close()
    const before = appMeta(m.path)

    const host = await bootHost(m)

    expect(host.outcome).toEqual({ kind: 'ready' })
    expect(host.states).toEqual(['starting', 'ready'])
    expect(host.database.capabilities()).toEqual(['db-read-only'])
    // hello.ok of this Host advertises it beside its methods and frames (14 §1.3; ADR-005 item 5).
    const runDir = join(m.dataDir, 'run')
    const token = new UiToken()
    await token.issue(runDir)
    const connections = new ConnectionRegistry()
    const state = new HostStateHolder(connections)
    state.report({ state: 'ready', jobStatus: 'n/a' })
    const log = new RecordingDiagnosticsLog()
    const scheduler = new FakeScheduler(m.clock)
    const dispatcher = new Dispatcher({
      log,
      clock: m.clock,
      scheduler,
      state: () => state.current().state
    })
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids: m.ids,
      identity: {
        hostVersion: '0.0.0-test',
        buildId: 'abc1234',
        protocolVersion: PROTOCOL_VERSION
      },
      epoch: host.epoch,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({
          methods: dispatcher.methods(),
          frames: LIFECYCLE_FRAMES,
          conditions: host.database.capabilities()
        }),
      scheduler,
      clock: m.clock,
      log,
      dispatcher,
      connections,
      throttle: new HelloThrottle(m.clock)
    })
    const client = new FrameClient(pair.client)
    cleanups.push(() => void pair.client.destroy())
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role: 'ui',
      token: readFileSync(join(runDir, UI_TOKEN_FILE), 'utf8'),
      client: { appVersion: '0.0.0-test', buildId: 'abc1234', pid: 4242 }
    })
    await client.until(() => client.frames.length > 0)
    expect(client.frames[0]).toMatchObject({
      type: 'hello.ok',
      state: 'ready',
      capabilities: expect.arrayContaining(['db-read-only', 'frame:host.state'])
    })
    // Nothing is written to a newer file: no epoch, and a clean exit leaves no marker.
    host.database.checkpoint.flush()
    host.database.checkpoint.markClean('stop-all')
    host.database.close()
    expect(appMeta(m.path)).toEqual(before)
  })

  it('[ADR-002] a clean stop-all exit leaves a marker with reason stop-all, which the next boot reads as clean', async () => {
    const m = machine()
    const first = await bootHost(m)
    m.clock.advance(60_000)
    const exits: number[] = []
    const cleanExit = createCleanExit({
      checkpoint: first.database.checkpoint,
      connections: new ConnectionRegistry(),
      endpoint: { close: () => Promise.resolve() },
      scheduler: new FakeScheduler(m.clock),
      log: first.log,
      exit: (code) => exits.push(code)
    })

    await cleanExit.closeCleanly('stop-all')

    expect(exits).toEqual([0])
    // The checkpoint left the marker in the main file and an empty write-ahead log (09 §8.1).
    expect(statSync(`${m.path}-wal`).size).toBe(0)
    first.database.close()
    expect(appMeta(m.path)).toMatchObject({
      current_host_epoch: first.epoch,
      clean_shutdown_epoch: first.epoch,
      clean_shutdown_at: T0 + 60_000,
      clean_shutdown_reason: 'stop-all'
    })

    const second = await bootHost(m)

    expect(second.database.previousEpochEnd()).toEqual({
      kind: 'clean',
      rule: 'none',
      cleanReason: 'stop-all'
    })
    expect(second.log.byEvent('host.boot.unclean')).toEqual([])
    expect(second.log.byEvent('host.boot.rebooted')).toEqual([])
  })

  it('[FM-008, FM-102] a file that is not a DwarfAI database fails the boot at step 2 with its refusal code', async () => {
    const m = machine()
    const foreign = NodeSqliteDatabase.open(m.path)
    foreign.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY)')
    foreign.close()

    const host = await bootHost(m)

    expect(host.outcome).toEqual({ kind: 'failed', step: 'open-db-and-migrate' })
    expect(host.exits).toEqual([BOOT_FAILED_EXIT_CODE])
    expect(host.log.byEvent('host.boot.step').at(-1)).toEqual(
      expect.objectContaining({
        level: 'error',
        causeClass: 'open-db-and-migrate',
        outcome: 'failed',
        errCode: 'NOT_A_DWARFAI_DB'
      })
    )
    expect(host.states).toEqual(['starting'])
  })
})
