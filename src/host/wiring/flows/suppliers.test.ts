// layer: L2
// L2 flow (17 §1.2): the suppliers module constructed by boot step 4 (16 §8.2) through
// host/wiring/suppliersWiring.ts, over a real database file in a temp directory (so a restart is
// the composition built again over the same file, CH-01), a FakeClock and FakeScheduler, an inline
// InstallResolver double and the other ports faked. The suppliers module's own doubles stay inside
// that module (R15): this suite uses the module's index.ts and inline doubles only.
//
// TC-159-01 … TC-159-03.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { HostEpoch } from '../../kernel/domain/values'
import type { InstallResolver, Suppliers, SuppliersEvent } from '../../modules/suppliers'
import { SqliteCapabilityRecordStore } from '../../modules/suppliers/adapters/sqlite/SqliteCapabilityRecordStore'
import { migrationsFor } from '../../platform/sqlite/migrations'
import { runBoot, type BootOutcome } from '../boot'
import { createBootSteps, mintBootEpoch } from '../bootSteps'
import { createHostDatabase, HOST_DB_FILE } from '../hostDatabase'
import { isPublicBuild, wireSuppliers } from '../suppliersWiring'

const T0 = 1_790_000_000_000
const HOUR_MS = 3_600_000
/** ADR-009 D5: the detection budget of one Add-panel open. */
const BUDGET_MS = 500

const NO_FILE_PROTECTION = {
  dataDir: () => Promise.resolve(),
  dbFiles: () => Promise.resolve()
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/**
 * The person's CLIs as the one `InstallResolver` finds them (inline double, R15): each binary
 * resolves to its path after `delayMs` on the Host's scheduler; any other binary is not installed.
 */
function resolverOf(
  scheduler: FakeScheduler,
  installed: readonly string[],
  delayMs = 0
): InstallResolver {
  const answer = (binaries: readonly string[]) => {
    const binary = binaries.find((name) => installed.includes(name))
    return binary === undefined
      ? null
      : { path: `/opt/tools/${binary}`, version: '1.0.0', resolvedVia: 'path' as const }
  }
  return {
    resolve: (binaries) =>
      delayMs === 0
        ? Promise.resolve(answer(binaries))
        : new Promise((resolve) => scheduler.after(delayMs, () => resolve(answer(binaries))))
  }
}

/** One machine: one data directory, one clock, the person's installed CLIs. */
function machine(options: { installed?: readonly string[]; resolveDelayMs?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dwarfai-159-suppliers-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const processControl = new FakeProcessControl({ bootId: 'boot-one', clock })
  processControl.scriptBootIdentity({ bootTimeMs: T0 - HOUR_MS, logonSessionId: 'logon-one' })
  const fs = new FakeFs()
  const installed = options.installed ?? []
  for (const binary of installed) fs.addFile(`/opt/tools/${binary}`, 'cli', 1)
  return {
    dataDir,
    clock,
    scheduler,
    processControl,
    fs,
    ids: new SequenceIdGenerator(),
    resolver: resolverOf(scheduler, installed, options.resolveDelayMs)
  }
}

type Machine = ReturnType<typeof machine>

interface BootedHost {
  outcome: BootOutcome
  suppliers: Suppliers | undefined
  capabilityRecords: SqliteCapabilityRecordStore | undefined
  bus: RecordingEventBus<SuppliersEvent>
  /** The Host killed: its database connection closed (CH-01). */
  close(): void
}

/** One Host start on `m`: the real step list, step 4 wiring suppliers over the opened database. */
async function bootHost(m: Machine, options: { publicBuild?: boolean } = {}): Promise<BootedHost> {
  const log = new RecordingDiagnosticsLog()
  const epoch = mintBootEpoch(m.ids)
  const database = createHostDatabase({
    path: join(m.dataDir, HOST_DB_FILE),
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
  const bus = new RecordingEventBus<SuppliersEvent>()
  const booted: Omit<BootedHost, 'outcome'> = {
    suppliers: undefined,
    capabilityRecords: undefined,
    bus,
    close: () => database.close()
  }
  const outcome = await runBoot(
    (paths) =>
      createBootSteps({
        paths,
        clock: m.clock,
        scheduler: m.scheduler,
        ids: m.ids,
        fs: m.fs,
        processControl: m.processControl,
        log,
        endpoint: { bind: () => Promise.resolve('bound'), close: () => Promise.resolve() },
        database,
        // What host/main.ts does at step 4, with this machine's adapters.
        constructModules: () => {
          const { db, transactions } = database.connection()
          const capabilityRecords = new SqliteCapabilityRecordStore({
            db,
            tx: transactions,
            ids: m.ids,
            log
          })
          booted.capabilityRecords = capabilityRecords
          booted.suppliers = wireSuppliers({
            publicBuild: options.publicBuild ?? false,
            clock: m.clock,
            scheduler: m.scheduler,
            ids: m.ids,
            fs: m.fs,
            log,
            installResolver: m.resolver,
            capabilityRecords,
            bus,
            hostEpoch: epoch as HostEpoch,
            simulatedSeed: epoch
          })
        }
      }),
    {
      log,
      clock: m.clock,
      state: { report: () => undefined },
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: m.dataDir }) },
      runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
      exit: () => undefined
    }
  )
  return { outcome, ...booted }
}

/** Lets the promise chains of a check that already has its answer settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** The wired module, or a failed expectation naming the missing step-4 wiring. */
function wired(host: BootedHost): Suppliers {
  expect(host.suppliers, 'boot step 4 constructed no suppliers module').toBeDefined()
  return host.suppliers as Suppliers
}

describe('suppliers wiring', () => {
  it('[INV-41] a booted Host answers launchable with the installed catalog providers only', async () => {
    const m = machine({ installed: ['claude', 'opencode'] })
    const host = await bootHost(m)
    expect(host.outcome).toEqual({ kind: 'ready' })
    const catalogue = wired(host).catalogue

    const launchable = await catalogue.launchable()

    // No real driver is attached yet (fail closed since ISSUE-147): of the installed providers,
    // only the simulated one, whose driver this development build attaches, can launch.
    expect(launchable.map((entry) => entry.providerId)).toEqual(['simulated'])
    expect(launchable.every((entry) => entry.installed)).toBe(true)
    expect(catalogue.entry('claude')?.installed).toBe(true)
    expect(catalogue.entry('opencode')?.installed).toBe(true)
    expect(catalogue.entry('codex')?.installed).toBe(false)
    expect(catalogue.entry('antigravity')?.installed).toBe(false)
  })

  it('[ADR-009] a booted Host has run one detection, so a first CLI check slower than the budget is installed at the first Add-panel open', async () => {
    const m = machine({ installed: ['claude'], resolveDelayMs: BUDGET_MS + 300 })
    const host = await bootHost(m)
    const catalogue = wired(host).catalogue

    // The first `--version` answers after the budget (ADR-009 D5); the panel opens after it did.
    m.clock.advance(BUDGET_MS + 300)
    await settle()
    const opened = catalogue.launchable()
    await settle()
    m.clock.advance(BUDGET_MS)
    await opened

    expect(catalogue.entry('claude')?.installed).toBe(true)
  })

  it('[NFR-OBS-04] a capability record written before a Host restart is read back after it', async () => {
    const m = machine()
    const first = await bootHost(m)
    expect(first.outcome).toEqual({ kind: 'ready' })
    await settle()
    const recordedAt = m.clock.now()
    first.close()

    m.clock.advance(HOUR_MS)
    const second = await bootHost(m)
    expect(second.outcome).toEqual({ kind: 'ready' })

    // The first Host probed the simulated provider at its start and recorded it with its
    // version and date; the second reads that row from the same file.
    expect(second.capabilityRecords?.latest('simulated')).toMatchObject({
      version: 'simulated',
      at: recordedAt,
      caps: { launch: true }
    })
  })

  it("[C-27] before preferences is wired a gated provider's answer channel is gated-off", async () => {
    const m = machine({ installed: ['opencode'] })
    const host = await bootHost(m)
    const catalogue = wired(host).catalogue
    await catalogue.launchable()

    expect(catalogue.entry('opencode')).toMatchObject({
      gatingIntegration: 'opencode-permissions',
      answerChannel: 'gated-off'
    })
    expect(catalogue.capabilities('opencode')).toMatchObject({
      permission: 'none',
      question: 'none'
    })
  })

  it('[ADR-009] a development build registers SimulatedDriver and a public build does not', async () => {
    const development = wired(await bootHost(machine(), { publicBuild: isPublicBuild('dev') }))
    const test = wired(await bootHost(machine(), { publicBuild: isPublicBuild('test') }))
    const release = wired(await bootHost(machine(), { publicBuild: isPublicBuild('release') }))

    expect(development.registry.drivers('simulated').map((driver) => driver.transport)).toEqual([
      'acp'
    ])
    expect(test.registry.drivers('simulated')).toHaveLength(1)
    expect(release.registry.drivers('simulated')).toEqual([])
    expect(release.catalogue.entry('simulated')).toBeNull()
  })
})
