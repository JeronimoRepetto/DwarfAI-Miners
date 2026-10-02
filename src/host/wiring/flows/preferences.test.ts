// layer: L2
// L2 flow (17 §1.2): the preferences module wired into the Host (05 §4; 16 §8.2) through
// host/wiring/preferencesWiring.ts, as host/main.ts wires it: constructed at boot step 3, which
// resumes an unfinished Reset saga before any command is accepted (ADR-023 item 4; 07 S13.08), with
// its seam-B members (14 §2.3 B-M09, B-M12, B-M13, B-M15; §2.4 B-F24, B-F26, B-F27) served over
// the real transport — connections behind in-process duplexes, the Host dispatcher, the connection
// registry — and the fail-closed bridges of cut 1 (kernel `SecretReader`, suppliers
// `IntegrationGateReader`). A real database file in a temp directory, so a restart is the
// composition built again over the same file; a Host killed mid-saga is the CH-01 fake injector:
// from the kill on, every statement of that Host's connection throws, and that Host is dropped.
// The real preferences module, a FakeFs, the real FeatureFlagReader over it, and no module double
// from outside its module (R15).
//
// TC-226-01 … TC-226-03.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema
} from '@dwarfai/contracts'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { HostEpoch } from '../../kernel/domain/values'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import type { FileSystem } from '../../kernel/ports/fileSystem'
import type { SecretName } from '../../kernel/ports/secretReader'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { PreferencesEvent, SecretStore } from '../../modules/preferences'
import { migrationsFor } from '../../platform/sqlite/migrations'
import { SqliteResetCleanup } from '../../platform/sqlite/resetCleanup'
import { HelloThrottle } from '../../transport/auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../../transport/auth/uiToken'
import { collectCapabilities } from '../../transport/capabilities'
import { acceptConnection } from '../../transport/connection'
import { ConnectionRegistry } from '../../transport/connectionRegistry'
import { TRANSPORT_FRAMES } from '../../transport/events/framePublisher'
import { createUpgradeDrain } from '../../transport/lifecycle/drain'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import { createUpgradeTargetRule } from '../../transport/methods/hostUpgradeRequest'
import { PREFERENCES_FRAMES } from '../../transport/methods/preferences'
import { RESET_FRAMES } from '../../transport/methods/resetMetrics'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { FrameClient } from '../../transport/testing/frameClient'
import { inProcessDuplex } from '../../transport/testing/inProcessDuplex'
import { runBoot, type BootOutcome } from '../boot'
import { createBootSteps, mintBootEpoch } from '../bootSteps'
import { emptyDrainGate } from '../emptyDrainGate'
import { createFeatureFlagReader, featureFlagConfigFilePath } from '../featureFlagReader'
import { createHostDatabase, HOST_DB_FILE } from '../hostDatabase'
import { createHostDispatcher } from '../hostDispatcher'
import {
  emptyLedgerInstallMoment,
  noOwnedConfigWriter,
  unavailableSecretStore,
  wirePreferences,
  type WiredPreferences
} from '../preferencesWiring'

const T0 = 1_790_000_000_000
const HOUR_MS = 3_600_000
const RID_1 = '01890a5d-ac96-774b-bcce-b302099a8061'
const RID_2 = '01890a5d-ac96-774b-bcce-b302099a8062'
const MINE = '00000000-0000-7000-8000-0000000226f1'
const DWARF = '00000000-0000-7000-8000-0000000226d1'
const RESET_STEPS = ['db', 'secrets', 'external-config', 'ui-prefs', 'install-moment', 'done']

const NO_FILE_PROTECTION = {
  dataDir: () => Promise.resolve(),
  dbFiles: () => Promise.resolve()
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** The process of a killed Host is gone: nothing it would still do runs (CH-01). */
class HostKilled extends Error {
  constructor() {
    super('CH-01: the Host was killed')
    this.name = 'HostKilled'
  }
}

/** The Host's connection, which the fake injector can kill: every later call throws. */
function killable(db: SqliteDatabase): SqliteDatabase & { kill(): void } {
  let killed = false
  const guard = <T>(work: () => T): T => {
    if (killed) throw new HostKilled()
    return work()
  }
  return {
    exec: (sql) => guard(() => db.exec(sql)),
    run: (sql, params) => guard(() => db.run(sql, params)),
    all: (sql, params) => guard(() => db.all(sql, params)),
    openReader: () => guard(() => db.openReader()),
    close: () => db.close(),
    kill: () => {
      killed = true
    }
  }
}

/** A FileSystem that counts every call made through it. */
function counted(fs: FileSystem): { fs: FileSystem; calls: () => number } {
  let calls = 0
  const proxy = new Proxy(fs, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls += 1
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
  })
  return { fs: proxy, calls: () => calls }
}

/** One machine: one data directory with its database file, one clock, the run token. */
function machine() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dwarfai-226-preferences-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const clock = new FakeClock(T0)
  const processControl = new FakeProcessControl({ bootId: 'boot-one', clock })
  processControl.scriptBootIdentity({ bootTimeMs: T0 - HOUR_MS, logonSessionId: 'logon-one' })
  const fs = counted(new FakeFs())
  return {
    dataDir,
    clock,
    scheduler: new FakeScheduler(clock),
    processControl,
    fs,
    ids: new SequenceIdGenerator()
  }
}

type Machine = ReturnType<typeof machine>

interface HostOptions {
  /** CH-01: the Host is killed when the saga reaches its `secrets` step. */
  killAtSecrets?: boolean
  /** A `ui` client attached before the boot runs (it connects while the Host is `starting`). */
  attachBeforeBoot?: boolean
}

/**
 * One Host start on `m`: the real boot step list, step 3 wiring preferences over the opened
 * database as host/main.ts does, the real Host dispatcher and connection registry.
 */
async function bootHost(m: Machine, options: HostOptions = {}) {
  const log = new RecordingDiagnosticsLog()
  const epoch = mintBootEpoch(m.ids)
  const path = join(m.dataDir, HOST_DB_FILE)
  const database = createHostDatabase({
    path,
    epoch,
    clock: m.clock,
    log,
    processControl: m.processControl,
    open: {
      buildKind: 'test',
      releaseDataDir: join(m.dataDir, 'release-data'),
      appVersion: '0.0.0-test',
      migrations: migrationsFor({ clock: m.clock, ids: m.ids })
    },
    protectFiles: NO_FILE_PROTECTION
  })
  cleanups.push(() => database.close())
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  const sections = new SectionRegistry()
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  const dispatcher = createHostDispatcher({
    log,
    clock: m.clock,
    scheduler: m.scheduler,
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch,
    ids: m.ids,
    sections,
    snapshotMeta: {
      hostVersion: () => '0.0.0-test',
      state: () => state.current().state,
      resetEpoch: () => database.resetEpoch(),
      snapshotTail: () => 20,
      minesEverKnown: () => false
    },
    drain: createUpgradeDrain({
      gate: emptyDrainGate,
      state,
      scheduler: m.scheduler,
      lifecycle,
      log
    }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })
  const runDir = join(m.dataDir, 'run')
  const token = new UiToken()
  await token.issue(runDir)
  const secret = readFileSync(join(runDir, UI_TOKEN_FILE), 'utf8')
  const throttle = new HelloThrottle(m.clock)

  /** Connects a client with `role` and returns it once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier' = 'ui'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids: m.ids,
      identity: {
        hostVersion: '0.0.0-test',
        buildId: 'abc1234',
        protocolVersion: PROTOCOL_VERSION
      },
      epoch,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({
          methods: dispatcher.methods(),
          frames: [...TRANSPORT_FRAMES, ...PREFERENCES_FRAMES, ...RESET_FRAMES],
          sections: sections.names()
        }),
      scheduler: m.scheduler,
      clock: m.clock,
      log,
      dispatcher,
      connections,
      throttle
    })
    const client = new FrameClient(pair.client)
    cleanups.push(() => void pair.client.destroy())
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.0.0-test', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }

  const early = options.attachBeforeBoot === true ? await attach() : undefined
  const journal = () => ({
    ...database.connection().db.all('SELECT step, epoch, last_failure FROM reset_journal')[0]
  })
  const host: {
    wired?: WiredPreferences
    db?: SqliteDatabase & { kill(): void }
    /** The journal row each time the Host reported `ready` (commands are accepted from then). */
    atReady: Array<Record<string, unknown>>
    /** Every state the boot reported, in order. */
    states: string[]
  } = { atReady: [], states: [] }

  const boot: Promise<BootOutcome> = runBoot(
    (paths) =>
      createBootSteps({
        paths,
        clock: m.clock,
        scheduler: m.scheduler,
        ids: m.ids,
        fs: m.fs.fs,
        processControl: m.processControl,
        log,
        endpoint: { bind: () => Promise.resolve('bound'), close: () => Promise.resolve() },
        database,
        // What host/main.ts does at step 3, with this machine's adapters.
        resumeResetSaga: async () => {
          const connection = database.connection()
          const db = killable(connection.db)
          host.db = db
          const bus = new InProcessEventBus<PreferencesEvent>({
            transactionScope: connection.transactions,
            onHandlerError: () => undefined
          })
          const secrets: SecretStore =
            options.killAtSecrets === true
              ? {
                  ...unavailableSecretStore,
                  delete: () => {
                    db.kill()
                    return Promise.reject(new HostKilled())
                  }
                }
              : unavailableSecretStore
          host.wired = wirePreferences({
            db,
            transactions: connection.transactions,
            bus,
            clock: m.clock,
            ids: m.ids,
            hostEpoch: epoch as HostEpoch,
            log,
            featureFlags: await createFeatureFlagReader({
              env: {},
              fs: m.fs.fs,
              configFilePath: featureFlagConfigFilePath(m.dataDir),
              log
            }),
            maintenance: new SqliteResetCleanup({ db, path }),
            ledger: emptyLedgerInstallMoment,
            secrets,
            externalConfig: noOwnedConfigWriter,
            connections,
            dispatcher,
            sections,
            ready: () => state.current().state === 'ready'
          })
          return host.wired.resumeOnBoot()
        }
      }),
    {
      log,
      clock: m.clock,
      state: {
        report: (report) => {
          host.states.push(report.state)
          if (report.state === 'ready') host.atReady.push(journal())
          state.report(report)
        }
      },
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: m.dataDir }) },
      runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
      exit: () => undefined
    }
  )
  let outcome: BootOutcome | undefined
  void boot.then((settled) => (outcome = settled))
  for (let i = 0; i < 200 && outcome === undefined; i += 1) await tick()

  return {
    ...host,
    outcome,
    early,
    attach,
    journal,
    log,
    database,
    bootSteps: () => log.byEvent('host.boot.step').map((entry) => entry.causeClass),
    close: () => database.close()
  }
}

/** Lets pending promise chains and in-process stream events run (no timer). */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/** The wired preferences, or a failed expectation naming the missing step-3 wiring. */
function wiredOf(host: { wired?: WiredPreferences }): WiredPreferences {
  expect(host.wired, 'boot step 3 wired no preferences module').toBeDefined()
  return host.wired as WiredPreferences
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

/** Sends one request; returns its id. */
function request(client: FrameClient, method: string, params: unknown): string {
  nextId += 1
  const id = `req-${nextId}`
  client.send({ type: 'req', id, method, params })
  return id
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

/** Lets the in-process streams run until `condition` holds, a bounded number of ticks. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) await tick()
}

/** Waits for the `res` of request `id` and returns it. */
async function response(client: FrameClient, id: string): Promise<Res> {
  await until(() => client.frames.some((frame) => isRes(frame, id)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
}

type WireItem = { kind: string; name?: string; data?: unknown; id?: string }

/** Each frame a client received after hello, as `evt <name> <data>` or `res`, in order. */
function wire(client: FrameClient): WireItem[] {
  return client.frames.slice(1).flatMap((frame): WireItem[] => {
    const type = (frame as { type?: string }).type
    if (type === 'evt') {
      const evt = evtFrameSchema.parse(frame)
      return [{ kind: 'evt', name: evt.name, data: evt.data }]
    }
    if (type === 'res') return [{ kind: 'res', id: (frame as { id?: string }).id }]
    return []
  })
}

function names(client: FrameClient, keep: (item: WireItem) => boolean): string[] {
  return wire(client)
    .filter(keep)
    .map((item) => item.name ?? 'res')
}

/** Acks every `ui.resetPreferences` the client received so far, as UI main does (14 §4.3 rule 4). */
async function ackResets(client: FrameClient): Promise<void> {
  for (const item of wire(client)) {
    if (item.name !== 'ui.resetPreferences') continue
    const ack = request(client, 'ui.resetPreferences.ack', item.data)
    expect((await response(client, ack)).ok).toBe(true)
  }
}

/** Runs `resetMetrics` on a Host that is killed during it: the call never answers `reset`. */
async function killedDuring(wired: WiredPreferences): Promise<void> {
  let answered: unknown = null
  try {
    answered = await wired.preferences.commands.resetMetrics({ confirmed: 'yes' })
  } catch (error) {
    expect(error).toBeInstanceOf(HostKilled)
    return
  }
  expect(answered).not.toMatchObject({ outcome: 'reset' })
}

/** A Host killed mid-saga (CH-01) on `m`: its journal row is left at `db`. */
async function killedMidSaga(m: Machine): Promise<void> {
  const killed = await bootHost(m, { killAtSecrets: true })
  expect(killed.outcome).toEqual({ kind: 'ready' })
  await killedDuring(wiredOf(killed))
  killed.close()
}

describe('preferences wiring', () => {
  it('[S13.08, FM-019] an unfinished saga resumes at boot before any command is accepted', async () => {
    const m = machine()
    await killedMidSaga(m)

    const next = await bootHost(m)

    expect(next.outcome).toEqual({ kind: 'ready' })
    // At the moment the Host answers commands (`ready`, 14 §3.3 HOST_NOT_READY before it), the
    // resumed saga is done, with the one epoch of the killed saga.
    expect(next.atReady).toEqual([{ step: 'done', epoch: 1, last_failure: null }])
    expect(next.log.byEvent('reset.resumed')).toMatchObject([{ msg: 'db' }])
    const ran = next.bootSteps()
    expect(ran.indexOf('resume-reset-saga')).toBeGreaterThanOrEqual(0)
    expect(ran.indexOf('resume-reset-saga')).toBeLessThan(ran.indexOf('construct-modules'))
    expect(ran.indexOf('resume-reset-saga')).toBeLessThan(ran.indexOf('answer-ready'))
  })

  it('[ADR-024] preferences.set of systemNotificationsOn over the wired Host reaches every ui client as preferences.changed', async () => {
    const host = await bootHost(machine())
    expect(host.outcome).toEqual({ kind: 'ready' })
    const a = await host.attach()
    const b = await host.attach()
    expect((a.frames[0] as { capabilities?: string[] }).capabilities).toEqual(
      expect.arrayContaining([
        'preferences.get',
        'preferences.set',
        'preferences.resetMetrics',
        'ui.resetPreferences.ack',
        'section:preferences'
      ])
    )

    const id = request(a, 'preferences.set', {
      key: 'systemNotificationsOn',
      value: false,
      requestId: RID_1
    })
    const res = await response(a, id)
    await until(() => wire(b).some((item) => item.name === 'preferences.changed'))

    expect(res.ok && res.result).toMatchObject({ systemNotificationsOn: false })
    // 14 §1.7 "effects before response": the frame precedes the res on the caller's wire.
    expect(names(a, (item) => item.name === 'preferences.changed' || item.id === id)).toEqual([
      'preferences.changed',
      'res'
    ])
    for (const client of [a, b]) {
      const changed = wire(client).filter((item) => item.name === 'preferences.changed')
      expect(changed).toHaveLength(1)
      expect(changed[0]?.data).toMatchObject({ preferences: { systemNotificationsOn: false } })
    }
    const got = request(b, 'preferences.get', {})
    const read = await response(b, got)
    expect(read.ok && read.result).toMatchObject({
      preferences: { systemNotificationsOn: false }
    })
  })

  it('[ADR-023] preferences.resetMetrics over the wired Host runs the saga with the registered participants and pushes reset.progress', async () => {
    const host = await bootHost(machine())
    expect(host.outcome).toEqual({ kind: 'ready' })
    const { db, transactions } = host.database.connection()
    // A past turn-finished key of a dwarf, which the attention step deletes (09 §7.2).
    transactions.inTransaction(() => {
      db.run(
        `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
         VALUES (?, '/work/moria', 'Moria', 'moria', 'active', ?, ?)`,
        [MINE, T0, T0]
      )
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at)
         VALUES (?, ?, 'claude', 'session-1', 'Gimli', 'foreman', 'running', 'none-yet', ?, ?)`,
        [DWARF, MINE, T0, T0]
      )
      db.run(
        `INSERT INTO attention_keys (key, dwarf_id, kind, ask_id, host_epoch, emitted_at)
         VALUES (?, ?, 'turn-finished', NULL, 'epoch-old', ?)`,
        [`${DWARF}:turn-finished:turn-1`, DWARF, T0]
      )
    })
    const a = await host.attach()
    const b = await host.attach()
    const set = request(a, 'preferences.set', {
      key: 'systemNotificationsOn',
      value: false,
      requestId: RID_1
    })
    expect((await response(a, set)).ok).toBe(true)

    const id = request(a, 'preferences.resetMetrics', { confirmed: 'yes', requestId: RID_2 })
    await until(() =>
      [a, b].every((client) => wire(client).some((item) => item.name === 'ui.resetPreferences'))
    )
    await ackResets(a)
    await ackResets(b)
    const res = await response(a, id)

    expect(res.ok && res.result).toStrictEqual({ outcome: 'reset', epoch: 1 })
    // 14 §6.3 "Reset saga progress", on every ui connection.
    for (const client of [a, b]) {
      const reset = wire(client).filter(
        (item) =>
          item.name === 'resync-required' ||
          item.name === 'reset.progress' ||
          item.name === 'ui.resetPreferences'
      )
      expect(reset.map((item) => item.name)).toStrictEqual([
        'resync-required',
        'reset.progress',
        'reset.progress',
        'reset.progress',
        'ui.resetPreferences',
        'reset.progress',
        'reset.progress',
        'reset.progress'
      ])
      expect(
        reset.filter((item) => item.name === 'reset.progress').map((item) => item.data)
      ).toStrictEqual(RESET_STEPS.map((step) => ({ resetId: expect.any(String), epoch: 1, step })))
    }
    // The command's result comes after its last progress frame.
    expect(names(a, (item) => item.name === 'reset.progress' || item.id === id).at(-1)).toBe('res')
    // The registered participants ran in the saga's db transaction: preferences to their defaults,
    // the attention key gone.
    expect(host.wired?.preferences.queries.get()).toMatchObject({ systemNotificationsOn: true })
    expect(db.all('SELECT key FROM attention_keys')).toEqual([])
    expect(host.journal()).toMatchObject({ step: 'done', epoch: 1 })
  })

  it('[ADR-017] before the OS secret store is wired every SecretReader read answers not set and nothing is read from disk', async () => {
    const m = machine()
    const host = await bootHost(m)
    const reader = wiredOf(host).secretReader
    const before = m.fs.calls()

    const jevKey = await reader.read('jev-key')
    const password = await reader.read('opencode-password')

    expect([jevKey, password]).toEqual([null, null])
    expect(m.fs.calls()).toBe(before)
  })

  it('[ADR-011] before the integrations are wired the IntegrationGateReader bridge answers off for every integration', async () => {
    const host = await bootHost(machine())
    const { db, transactions } = host.database.connection()
    // Whatever the integration rows hold, nothing reads them before the store is wired.
    transactions.inTransaction(() =>
      db.run(`UPDATE integration_settings SET state = 'on-verified', consent_origin = 'settings'`)
    )
    const gate = wiredOf(host).integrationGate

    expect([gate.state('opencode-permissions'), gate.state('claude-hooks')]).toEqual(['off', 'off'])
  })

  it('[ADR-017] a SecretReader read of a name other than jev-key or opencode-password is refused', async () => {
    const m = machine()
    const host = await bootHost(m)
    const reader = wiredOf(host).secretReader
    const before = m.fs.calls()

    await expect(reader.read('anthropic-api-key' as SecretName)).rejects.toBeInstanceOf(
      HostInvariantError
    )
    expect(m.fs.calls()).toBe(before)
  })

  it('[S13.08, S13.09] a saga resumed at boot does not wait for a ui client attached before ready', async () => {
    const m = machine()
    await killedMidSaga(m)

    const next = await bootHost(m, { attachBeforeBoot: true })

    expect(next.outcome).toEqual({ kind: 'ready' })
    expect(next.atReady).toEqual([{ step: 'done', epoch: 1, last_failure: null }])
    // No command is answered before ready, so that client could not ack: it learns the epoch from
    // the snapshot meta section after ready instead (14 §4.3 rule 4).
    expect(names(next.early as FrameClient, (item) => item.name === 'ui.resetPreferences')).toEqual(
      []
    )
  })
})
