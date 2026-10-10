// layer: L2
// L2 flow (17 §1.2): the preferences module wired into the Host (05 §4; 16 §8.2) through
// host/wiring/preferencesWiring.ts, as host/main.ts wires it: its members served before the boot
// binds the endpoint (14 §1.3), the module constructed at boot step 3, which
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
//
// Since ISSUE-323 the harness composes cut 2 as host/main.ts does: the real config writer engine
// with the Claude Code hooks target over the FakeFs (bridges/hostConfigWriter.ts, the persisted
// ingress port of bridges/ingressPort.ts), its boot re-verification in step 3, the channel-token
// lookup the hook ingress reads (bridges/channelTokens.ts), the real suppliers module at step 4
// over an inline install resolver, and the first-run evaluation in step 8 over its installed
// detection (bridges/installedTools.ts). TC-323-01 … TC-323-03.
import { createHash } from 'node:crypto'
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
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import type { FileSystem } from '../../kernel/ports/fileSystem'
import type { SecretName } from '../../kernel/ports/secretReader'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { ExternalConfigWriter, PreferencesEvent, SecretStore } from '../../modules/preferences'
import { ClaudeHooksConfigWriter } from '../../modules/preferences/adapters/external-config/claudeHooks/ClaudeHooksConfigWriter'
import { ConfigWriterEngine } from '../../modules/preferences/adapters/external-config/configWriterEngine'
import { SqliteChannelTokenStore } from '../../modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { SqliteConfigWriteLedger } from '../../modules/preferences/adapters/sqlite/SqliteConfigWriteLedger'
import { SqliteIntegrationSettingStore } from '../../modules/preferences/adapters/sqlite/SqliteIntegrationSettingStore'
import { fixture } from '../../modules/preferences/adapters/external-config/claudeHooks/testing/claudeHooksWorld'
import type { InstallResolver, SuppliersEvent } from '../../modules/suppliers'
import { SqliteCapabilityRecordStore } from '../../modules/suppliers/adapters/sqlite/SqliteCapabilityRecordStore'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
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
import { createBootSteps, evaluateWelcomeAfterDetection, mintBootEpoch } from '../bootSteps'
import { hostConfigWriter, persistedIngressPort } from '../bridges/hostConfigWriter'
import { appMetaIngressPort } from '../bridges/ingressPort'
import { suppliersInstalledTools } from '../bridges/installedTools'
import { emptyDrainGate } from '../emptyDrainGate'
import { createFeatureFlagReader, featureFlagConfigFilePath } from '../featureFlagReader'
import { createHostDatabase, HOST_DB_FILE } from '../hostDatabase'
import { createHostDispatcher } from '../hostDispatcher'
import {
  servePreferences,
  unavailableSecretStore,
  type WiredPreferences
} from '../preferencesWiring'
import { wireSuppliers, type WiredSuppliers } from '../suppliersWiring'
import { createModuleResetSteps } from '../moduleResetSteps'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { Dispatcher } from '../../transport/dispatcher'

const T0 = 1_790_000_000_000
const HOUR_MS = 3_600_000
const RID_1 = '01890a5d-ac96-774b-bcce-b302099a8061'
const RID_2 = '01890a5d-ac96-774b-bcce-b302099a8062'
const MINE = '00000000-0000-7000-8000-0000000226f1'
const DWARF = '00000000-0000-7000-8000-0000000226d1'
const RESET_STEPS = ['db', 'secrets', 'external-config', 'ui-prefs', 'install-moment', 'done']
/** Claude Code's settings file on this machine (`CLAUDE_CONFIG_DIR` unset: `~/.claude`, 16 §7.1). */
const CLAUDE_SETTINGS = '/home/person/.claude/settings.json'
/** The port the hook ingress persisted when it first bound (ADR-016 item 3; later: ISSUE-140). */
const INGRESS_PORT = 41_234

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

/**
 * The person's CLIs as the one `InstallResolver` finds them (inline double, R15): each listed binary
 * resolves to its path at once; any other binary is not installed.
 */
function resolverOf(installed: readonly string[]): InstallResolver {
  return {
    resolve: (binaries) => {
      const binary = binaries.find((name) => installed.includes(name))
      return Promise.resolve(
        binary === undefined
          ? null
          : { path: `/opt/tools/${binary}`, version: '1.0.0', resolvedVia: 'path' as const }
      )
    }
  }
}

/** One machine: one data directory with its database file, one clock, the run token. */
function machine(options: { installed?: readonly string[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dwarfai-226-preferences-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const clock = new FakeClock(T0)
  const processControl = new FakeProcessControl({ bootId: 'boot-one', clock })
  processControl.scriptBootIdentity({ bootTimeMs: T0 - HOUR_MS, logonSessionId: 'logon-one' })
  const disk = new FakeFs()
  const installed = options.installed ?? []
  for (const binary of installed) disk.addFile(`/opt/tools/${binary}`, 'cli', 1)
  // Claude Code's own folder exists once it ran; its settings.json may not (16 §7.1).
  if (installed.includes('claude')) void disk.makeDir('/home/person/.claude')
  const fs = counted(disk)
  return {
    dataDir,
    clock,
    scheduler: new FakeScheduler(clock),
    processControl,
    disk,
    fs,
    ids: new SequenceIdGenerator(),
    resolver: resolverOf(installed)
  }
}

type Machine = ReturnType<typeof machine>

interface HostOptions {
  /** CH-01: the Host is killed when the saga reaches its `secrets` step. */
  killAtSecrets?: boolean
  /** CH-01: the Host is killed inside the saga's `db` step, before it commits. */
  killInDbStep?: boolean
  /** CH-01: the Host is killed right after the Claude Code settings file landed (before Tx B). */
  killAfterSettingsWrite?: boolean
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
  // What host/main.ts does before the boot: the members are served before the module exists.
  const preferences = servePreferences({ dispatcher, sections, connections })
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
    /** The config writer engine host/main.ts constructs at step 3 (its boot re-verification). */
    engine?: ConfigWriterEngine
    /** The suppliers module step 4 wired. */
    suppliers?: WiredSuppliers
    /** The integration gate step 4 gave suppliers. */
    suppliersGate?: WiredPreferences['integrationGate']
    /** The journal row each time the Host reported `ready` (commands are accepted from then). */
    atReady: Array<Record<string, unknown>>
    /** What preferences held each time the Host reported `ready`. */
    readyFacts: Array<{ welcome: unknown; claudeHooks: string; unverified: number }>
    /** Every state the boot reported, in order. */
    states: string[]
  } = { atReady: [], readyFacts: [], states: [] }
  const readyFacts = () => {
    const wired = host.wired
    const { db } = database.connection()
    return {
      welcome: wired?.preferences.queries.welcome(),
      claudeHooks: wired?.preferences.queries.integrationState('claude-hooks') ?? 'unwired',
      unverified: db.all(
        'SELECT id FROM config_writes WHERE verified_at IS NULL AND reverted_at IS NULL'
      ).length
    }
  }

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
          // What host/main.ts constructs at step 3 for cut 2 (ISSUE-323): the config writer engine
          // with the Claude Code hooks target over this machine's disk, behind the Host's per-target
          // writer, and the channel-token lookup the hook ingress reads.
          const ingressPort = appMetaIngressPort(db)
          const engine = new ConfigWriterEngine({
            fs: options.killAfterSettingsWrite === true ? killedAfterWrite(m.fs.fs, db) : m.fs.fs,
            transactions: connection.transactions,
            ledger: new SqliteConfigWriteLedger({ db }),
            settings: new SqliteIntegrationSettingStore({ db }),
            tokens: new SqliteChannelTokenStore({ db, ids: m.ids }),
            clock: m.clock,
            ids: m.ids,
            scheduler: m.scheduler,
            log,
            targets: [
              new ClaudeHooksConfigWriter({
                path: CLAUDE_SETTINGS,
                platform: 'linux',
                ingressPort: persistedIngressPort(ingressPort)
              })
            ]
          })
          host.engine = engine
          const moduleSteps = createModuleResetSteps({
            db,
            scope: connection.transactions,
            clock: m.clock,
            mapSites: [],
            random: () => 0
          }).steps
          if (options.killInDbStep === true) {
            moduleSteps.mines = {
              name: moduleSteps.mines.name,
              reset: () => {
                db.kill()
                throw new HostKilled()
              }
            }
          }
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
          host.wired = preferences.wire({
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
            // The ledger's install-moment writer and the cut-1 module steps, as host/main.ts binds them.
            ledger: new SqliteLedgerRepository({
              db,
              scope: connection.transactions,
              ids: m.ids,
              clock: m.clock
            }),
            moduleSteps,
            secrets,
            externalConfig: hostConfigWriter({ claudeHooks: engine, ingressPort, log }),
            channelTokens: new SqliteChannelTokenStore({ db, ids: m.ids }),
            installedTools: suppliersInstalledTools(() => host.suppliers?.catalogue ?? null),
            ready: () => state.current().state === 'ready'
          })
          return host.wired.resumeOnBoot()
        },
        // Step 3, after the resume: the boot re-verification of unverified config writes.
        reverifyConfigWrites: () => (host.engine as ConfigWriterEngine).settleUnverified(),
        // Step 4: the real suppliers module over this machine's CLIs, gated by preferences.
        constructModules: () => {
          const { db, transactions } = database.connection()
          const integrationGate = wiredOf(host).integrationGate
          host.suppliersGate = integrationGate
          host.suppliers = wireSuppliers({
            publicBuild: false,
            clock: m.clock,
            scheduler: m.scheduler,
            ids: m.ids,
            fs: m.fs.fs,
            log,
            installResolver: m.resolver,
            capabilityRecords: new SqliteCapabilityRecordStore({
              db,
              tx: transactions,
              ids: m.ids,
              log
            }),
            integrationGate,
            bus: new RecordingEventBus<SuppliersEvent>(),
            hostEpoch: epoch as HostEpoch,
            simulatedSeed: epoch
          })
        },
        // Step 8: the first-run evaluation, right after the start-up installed detection.
        evaluateWelcome: () =>
          evaluateWelcomeAfterDetection({
            detection: (host.suppliers as WiredSuppliers).bootDetection,
            evaluate: () => wiredOf(host).evaluateWelcomeAtBoot(),
            log
          })
      }),
    {
      log,
      clock: m.clock,
      state: {
        report: (report) => {
          host.states.push(report.state)
          if (report.state === 'ready') {
            host.atReady.push(journal())
            host.readyFacts.push(readyFacts())
          }
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

/**
 * CH-01 after the file landed: the engine's atomic write of the Claude Code settings file succeeds,
 * then the Host is killed, so Tx B never commits (16 §7.3).
 */
function killedAfterWrite(fs: FileSystem, db: { kill(): void }): FileSystem {
  return new Proxy(fs, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (property !== 'writeFileAtomic' || typeof value !== 'function') return value
      return async (path: string, bytes: Uint8Array | string) => {
        const written = await (value as FileSystem['writeFileAtomic']).call(target, path, bytes)
        if (path === CLAUDE_SETTINGS && written.ok) {
          db.kill()
          throw new HostKilled()
        }
        return written
      }
    }
  })
}

/** The SHA-256 of a channel token's hex text, as `channel_tokens` keeps it (ADR-016 item 1). */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
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

  // AMENDED for ISSUE-221: the module reads `integration_settings` since the Claude Code hooks
  // toggle joined it (16 §4.12 `integrationState`), so the bridge answers the stored state. Was:
  // "before the integrations are wired the IntegrationGateReader bridge answers off for every
  // integration", whatever the rows held.
  it('[ADR-011] the IntegrationGateReader bridge answers the stored state of every integration, off on a fresh database', async () => {
    const host = await bootHost(machine())
    const { db, transactions } = host.database.connection()
    const gate = wiredOf(host).integrationGate
    expect([gate.state('opencode-permissions'), gate.state('claude-hooks')]).toEqual(['off', 'off'])

    transactions.inTransaction(() =>
      db.run(`UPDATE integration_settings SET state = 'on-verified', consent_origin = 'settings'`)
    )

    expect([gate.state('opencode-permissions'), gate.state('claude-hooks')]).toEqual([
      'on-verified',
      'on-verified'
    ])
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

  it('[ADR-003] a ui client attached before boot step 3 is offered the preferences members in hello.ok', async () => {
    const host = await bootHost(machine(), { attachBeforeBoot: true })
    expect(host.outcome).toEqual({ kind: 'ready' })
    const early = host.early as FrameClient

    // The client attached while the Host was `starting`; a HostClient never calls a method its
    // hello.ok did not list (14 §1.3), so the members are listed before the module exists.
    expect((early.frames[0] as { capabilities?: string[] }).capabilities).toEqual(
      expect.arrayContaining([
        'preferences.get',
        'preferences.set',
        'preferences.resetMetrics',
        'ui.resetPreferences.ack',
        'section:preferences'
      ])
    )
    // Once ready, the same connection is served by the module step 3 constructed.
    const got = request(early, 'preferences.get', {})
    const read = await response(early, got)
    expect(read.ok && read.result).toMatchObject({ preferences: { systemNotificationsOn: true } })
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

// Added for ISSUE-222: the wiring joins the first-run consent step to the module's queries (16
// §4.12 `welcome()`), runs its boot evaluation over the installed-tools bridge and the config
// writer's legacy probe, and routes `WelcomeStepChanged` to B-F24 `preferences.changed` with the
// new step state (07 S41.05 "→ preferences.changed"; 14 §2.4).
describe('first-run consent step wiring (07 machine 41)', () => {
  /** A connection registry that records every frame published to it. */
  class RecordingConnections extends ConnectionRegistry {
    readonly frames: Array<{ name: string; data: unknown }> = []
    override publish: ConnectionRegistry['publish'] = (name, data) => {
      this.frames.push({ name, data })
    }
  }

  it('[S41.02, ADR-016] the wired step is evaluated at boot, served by welcome() and sent as preferences.changed; an old-app entry is listed, never adopted', async () => {
    const clock = new FakeClock(T0)
    const scheduler = new FakeScheduler(clock)
    const log = new RecordingDiagnosticsLog()
    const connections = new RecordingConnections()
    const served = servePreferences({
      dispatcher: new Dispatcher({ log, clock, scheduler, state: () => 'starting' }),
      sections: new SectionRegistry(),
      connections
    })
    const { db } = openTemplateCopy()
    const transactions = new SqliteTransactionRunner(db)
    const ids = new SequenceIdGenerator()
    // Both tools installed; the old app's Claude hook entry is on disk. The writer records every
    // write and revert, and keeps the old entry until one of them happens.
    const installedTools = {
      installed: () => ['claude-hooks' as const, 'opencode-permissions' as const]
    }
    const touched: string[] = []
    const writer: ExternalConfigWriter = {
      install: (target) => {
        touched.push(`install ${target}`)
        return Promise.resolve({ ok: false, error: 'io' })
      },
      verify: () => Promise.resolve('absent'),
      revert: (target) => {
        touched.push(`revert ${target}`)
        return Promise.resolve({ ok: true, value: undefined })
      },
      findLegacy: (target) => Promise.resolve(target === 'claude-hooks' && touched.length === 0)
    }
    const wired = served.wire({
      db,
      transactions,
      bus: new InProcessEventBus<PreferencesEvent>({
        transactionScope: transactions,
        onHandlerError: (failure) => {
          throw failure.error
        }
      }),
      clock,
      ids,
      hostEpoch: 'epoch-0222' as HostEpoch,
      log,
      featureFlags: await createFeatureFlagReader({
        env: {},
        fs: new FakeFs(),
        configFilePath: featureFlagConfigFilePath('/data'),
        log
      }),
      maintenance: {
        deleteBackups: () => undefined,
        truncateWal: () => undefined,
        vacuum: () => undefined
      },
      ledger: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
      moduleSteps: createModuleResetSteps({
        db,
        scope: transactions,
        clock,
        mapSites: [],
        random: () => 0
      }).steps,
      secrets: unavailableSecretStore,
      externalConfig: writer,
      installedTools,
      ready: () => false
    })
    expect(wired.preferences.queries.welcome()).toStrictEqual({
      due: false,
      legacyFound: [],
      offered: []
    })

    const due = {
      due: true,
      reason: 'legacy-entries',
      legacyFound: ['claude-hooks'],
      offered: ['claude-hooks']
    }
    expect(await wired.evaluateWelcomeAtBoot()).toStrictEqual(due)
    expect(wired.preferences.queries.welcome()).toStrictEqual(due)

    const sent = connections.frames.filter((frame) => frame.name === 'preferences.changed')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.data).toMatchObject({ welcome: due })
    validateFrame('preferences.changed', sent[0]?.data)
    expect(touched).toStrictEqual([])
    expect(await writer.findLegacy('claude-hooks')).toBe(true)
  })
})

// Added for ISSUE-323: cut 2's Claude Code hooks integration and the first-run consent step over the
// wired Host (05 §4; 16 §7.3, §8.2; 07 S14.11, S41.01; ADR-016 items 1, 5–7), composed as
// host/main.ts composes them. The hook ingress itself is wired by ISSUE-140 (review R7V-02): these
// cases read the lookup it will read, and persist the port it will persist when it first binds.
describe('Claude hooks integration and first-run step wiring (cut 2)', () => {
  const decoder = new TextDecoder()
  let nextRid = 0
  /** A fresh requestId for each mutating request (14 §1.6). */
  const rid = (): string => {
    nextRid += 1
    return `01890a5d-ac96-774b-bcce-b302${String(nextRid).padStart(8, '0')}`
  }

  /** What the hook ingress does when it first binds: its port is persisted (ADR-016 item 3). */
  const ingressBound = (host: { database: { connection(): { db: SqliteDatabase } } }): void =>
    appMetaIngressPort(host.database.connection().db).write(INGRESS_PORT)

  /** The plaintext token inside DwarfAI's hook entry in Claude Code's settings file. */
  const tokenOnDisk = async (m: Machine): Promise<string> => {
    const read = await m.disk.readFile(CLAUDE_SETTINGS)
    expect(read.ok, 'no Claude Code settings file was written').toBe(true)
    const text = read.ok ? decoder.decode(read.value) : ''
    const tokens = [...new Set(text.match(/[0-9a-f]{64}/g) ?? [])]
    expect(tokens).toHaveLength(1)
    return tokens[0] ?? ''
  }

  /** B-M39 over `client`, answered. */
  const setClaudeHooks = async (client: FrameClient, on: boolean): Promise<Res> =>
    response(client, request(client, 'preferences.setClaudeHooks', { on, requestId: rid() }))

  const integrationFrames = (client: FrameClient): unknown[] =>
    wire(client)
      .filter((item) => item.name === 'integration.changed')
      .map((item) => item.data)

  it("[ADR-016] turning Claude Code instant updates on over the wired Host reaches every ui client as integration.changed and the bridge's active-hash lookup returns the new token's hash", async () => {
    const m = machine({ installed: ['claude'] })
    const host = await bootHost(m)
    expect(host.outcome).toEqual({ kind: 'ready' })
    ingressBound(host)
    const a = await host.attach()
    const b = await host.attach()

    const answered = await setClaudeHooks(a, true)

    expect(answered.ok && answered.result).toStrictEqual({
      ok: true,
      value: { state: 'on-verified' }
    })
    await until(() => integrationFrames(b).length > 0)
    for (const client of [a, b]) {
      expect(integrationFrames(client)).toStrictEqual([
        { id: 'claude-hooks', state: 'on-verified', consentOrigin: 'settings' }
      ])
    }
    const token = await tokenOnDisk(m)
    expect(wiredOf(host).channelTokens.active('claude-hooks')).toStrictEqual({
      hash: sha256Hex(token)
    })
    expect(wiredOf(host).channelTokens.active('opencode-plugin')).toBeNull()
    // NFR-SEC-12, ADR-026: neither the token nor its hash reaches a frame, a log record or the
    // argv of a process (the Host spawned none for it).
    for (const secret of [token, sha256Hex(token)]) {
      expect(JSON.stringify([a.frames, b.frames])).not.toContain(secret)
      expect(JSON.stringify(host.log.entries)).not.toContain(secret)
      expect(JSON.stringify(m.processControl.spawns)).not.toContain(secret)
    }
  })

  it('[ADR-016] before the hook ingress persisted a port, turning Claude Code instant updates on writes nothing, issues no token and answers config-write-failed', async () => {
    const m = machine({ installed: ['claude'] })
    const host = await bootHost(m)
    const a = await host.attach()

    const answered = await setClaudeHooks(a, true)

    expect(answered.ok && answered.result).toStrictEqual({
      ok: false,
      error: 'config-write-failed'
    })
    expect(m.disk.headNow(CLAUDE_SETTINGS, 1)).toBeNull()
    expect(wiredOf(host).channelTokens.active('claude-hooks')).toBeNull()
    expect(host.database.connection().db.all('SELECT id FROM config_writes')).toStrictEqual([])
    expect(wiredOf(host).preferences.queries.integrationState('claude-hooks')).toBe('off')
  })

  it('[S14.11, FM-020, CH-01] a Host rebuilt between Tx A and Tx B re-verifies the write at boot before accepting commands', async () => {
    const m = machine({ installed: ['claude'] })
    const killed = await bootHost(m, { killAfterSettingsWrite: true })
    expect(killed.outcome).toEqual({ kind: 'ready' })
    ingressBound(killed)
    const a = await killed.attach()
    // The Host dies right after DwarfAI's entry landed in settings.json: Tx A is on record, Tx B
    // never ran, so the write is unverified and the integration still off.
    request(a, 'preferences.setClaudeHooks', { on: true, requestId: rid() })
    await until(() => m.disk.headNow(CLAUDE_SETTINGS, 1) !== null)
    for (let i = 0; i < 20; i += 1) await tick()
    killed.close()

    const next = await bootHost(m)

    expect(next.outcome).toEqual({ kind: 'ready' })
    // At the moment the Host answers commands the write is settled: verified, so on-verified.
    expect(next.readyFacts).toMatchObject([{ claudeHooks: 'on-verified', unverified: 0 }])
    const token = await tokenOnDisk(m)
    expect(wiredOf(next).channelTokens.active('claude-hooks')).toStrictEqual({
      hash: sha256Hex(token)
    })
    const ran = next.bootSteps()
    expect(ran.indexOf('resume-reset-saga')).toBeLessThan(ran.indexOf('construct-modules'))
    expect(ran.indexOf('resume-reset-saga')).toBeLessThan(ran.indexOf('answer-ready'))
  })

  it('[S13.08, S41.01] an unfinished saga resumes before the first-run evaluation, which runs before commands', async () => {
    const m = machine({ installed: ['claude'] })
    // The old app's hook entry is in Claude Code's settings file, beside the person's own hooks.
    m.disk.addFile(CLAUDE_SETTINGS, fixture('foreign-and-old-app.settings'))
    // A Reset killed after its db step: the saga is unfinished, its external-config step (which
    // reverts the Claude hooks target, old-app entry included, 16 §7.4) not run.
    const killed = await bootHost(m, { killAtSecrets: true })
    expect(killed.readyFacts).toMatchObject([
      { welcome: { due: true, reason: 'legacy-entries', legacyFound: ['claude-hooks'] } }
    ])
    await killedDuring(wiredOf(killed))
    killed.close()

    const next = await bootHost(m)

    expect(next.outcome).toEqual({ kind: 'ready' })
    // The resumed saga removed the old-app entry before the step was evaluated, so the step is due
    // as a first run, with nothing found; both were done when the Host answered commands.
    expect(next.atReady).toEqual([{ step: 'done', epoch: 1, last_failure: null }])
    expect(next.readyFacts).toMatchObject([
      {
        welcome: { due: true, reason: 'first-run', legacyFound: [], offered: ['claude-hooks'] }
      }
    ])
    const read = await m.disk.readFile(CLAUDE_SETTINGS)
    expect(read.ok && decoder.decode(read.value)).toBe(
      fixture('foreign-and-old-app.reverted.settings')
    )
  })

  it('[ADR-016] the first-run step is answered over the wired Host: B-M40 records Not now, settles the step in every ui client and the next boot does not show it', async () => {
    const m = machine({ installed: ['claude'] })
    const first = await bootHost(m)
    const a = await first.attach()
    const b = await first.attach()

    const answered = await response(
      a,
      request(a, 'preferences.answerWelcome', {
        claudeHooks: false,
        openCodePermissions: false,
        requestId: rid()
      })
    )

    expect(answered.ok && answered.result).toMatchObject({
      integrations: { 'claude-hooks': { state: 'off' } },
      welcome: { due: false }
    })
    await until(() => names(b, (item) => item.name === 'preferences.changed').length > 0)
    for (const client of [a, b]) {
      const sent = wire(client).filter((item) => item.name === 'preferences.changed')
      expect(sent.at(-1)?.data).toMatchObject({ welcome: { due: false } })
    }
    first.close()

    const next = await bootHost(m)
    expect(next.readyFacts).toMatchObject([{ welcome: { due: false, offered: ['claude-hooks'] } }])
  })

  it('[S41.01] a fresh profile with the Claude stub installed boots with the step due and offered claude-hooks', async () => {
    const host = await bootHost(machine({ installed: ['claude', 'opencode'] }))
    const due = { due: true, reason: 'first-run', legacyFound: [], offered: ['claude-hooks'] }

    expect(host.outcome).toEqual({ kind: 'ready' })
    expect(host.readyFacts).toMatchObject([{ welcome: due }])
    const a = await host.attach()
    const got = await response(a, request(a, 'preferences.get', {}))
    expect(got.ok && got.result).toMatchObject({ welcome: due })

    // S41.09: with no tool installed nothing is offered, and the step is not due.
    const bare = await bootHost(machine())
    expect(bare.readyFacts).toMatchObject([
      { welcome: { due: false, legacyFound: [], offered: [] } }
    ])
  })

  it('[ADR-011] the IntegrationGateReader bridge answers the stored integration state for suppliers', async () => {
    const m = machine({ installed: ['claude'] })
    const host = await bootHost(m)
    ingressBound(host)
    const gate = host.suppliersGate
    expect(gate, 'boot step 4 gave suppliers no integration gate').toBeDefined()
    expect(gate?.state('claude-hooks')).toBe('off')
    const a = await host.attach()

    await setClaudeHooks(a, true)
    expect(gate?.state('claude-hooks')).toBe('on-verified')

    await setClaudeHooks(a, false)
    expect(gate?.state('claude-hooks')).toBe('off')
  })

  it("[ADR-016] once the token rotated the bridge's active-hash lookup no longer returns the previous token's hash", async () => {
    const m = machine({ installed: ['claude'] })
    const host = await bootHost(m)
    ingressBound(host)
    const a = await host.attach()
    const lookup = wiredOf(host).channelTokens

    await setClaudeHooks(a, true)
    const previous = await tokenOnDisk(m)
    await setClaudeHooks(a, false)
    expect(lookup.active('claude-hooks')).toBeNull()
    await setClaudeHooks(a, true)
    const current = await tokenOnDisk(m)

    expect(current).not.toBe(previous)
    expect(lookup.active('claude-hooks')).toStrictEqual({ hash: sha256Hex(current) })
    expect(lookup.active('claude-hooks')).not.toStrictEqual({ hash: sha256Hex(previous) })
  })
})
