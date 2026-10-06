// layer: L2
// L2 flow (17 §1.2; 11 F2, F10; UC-007): the ledger module wired into the Host (05 §3.10, §4;
// 16 §8.2) through host/wiring/routes/ledger.ts and the `ObservedBatchSink` bridge
// (bridges/observedBatchSink.ts, AMENDMENT-10), as host/main.ts wires them: at boot step 4 the
// ledger first (over `SqliteLedgerRepository` and the coal backfill's `ProviderHistoryScanner`),
// then observation over the bridge, crew and mines (with the ledger's totals), and the ledger's
// routes once mines exists; after `ready`, the coal backfill. The real boot step list, the Host
// dispatcher, one copy of the template database, a FakeClock, FakeScheduler and
// FakeProcessControl.
//
// The conversation half of the bridge is not built yet (later: ISSUE-108, ISSUE-120): host/main.ts
// keeps observation stopped until it is, so these flows play it with a stand-in half that stores
// nothing and holds no event, which is what lets observation start here.
//
// The provider is Claude, laid out in a per-test temp home folder in its real spelling
// (17 §5.3) with the recorded fixture `fixtures/claude/observer/2.1.x/usage-rows.jsonl`
// (synthetic, scrubbed: three sealed usage units), whose working folder is rewritten to a real temp
// folder. No test reads the person's home folder or a provider credential (AGENTS §6).
//
// TC-096-01, TC-096-02, TC-096-03.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { FolderPath, HostEpoch, Instant, MineId } from '../../kernel/domain/values'
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
import type { DiagnosticEntry } from '../../kernel/ports/diagnosticsLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import type { BackfillReport } from '../../modules/ledger'
import { ProviderHistoryScanner } from '../../modules/ledger/adapters/ProviderHistoryScanner'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import { createMines } from '../../modules/mines'
import { createHostGitRepoInspector } from '../../modules/mines/adapters/FsGitRepoInspector'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
import { OBSERVATION_POLL_MS, createSqliteObservationStores } from '../../modules/observation'
import { NodeFs } from '../../platform/fs/NodeFs'
import { openReadOnlySnapshot } from '../../platform/sqlite/readOnlySnapshot'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { ConnectionRegistry } from '../../transport/connectionRegistry'
import { createUpgradeDrain } from '../../transport/lifecycle/drain'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import { createUpgradeTargetRule } from '../../transport/methods/hostUpgradeRequest'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { runBoot, type BootOutcome } from '../boot'
import { createBootSteps, mintBootEpoch } from '../bootSteps'
import { composeObservedBatchSink, type ObservedBatchHalf } from '../bridges/observedBatchSink'
import { emptyDrainGate } from '../emptyDrainGate'
import { createHostDispatcher } from '../hostDispatcher'
import { serveCrew, type CrewRouteEvent, type WiredCrew } from '../routes/crew'
import { wireLedger, type LedgerRouteEvent, type WiredLedger } from '../routes/ledger'
import {
  DEFAULT_MINES_SETTINGS,
  serveMines,
  type MinesRouteEvent,
  type WiredMines
} from '../routes/mines'
import {
  observationAdapters,
  observedProviderFolders,
  wireObservation,
  type WiredObservation
} from '../routes/observation'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures')
const SESSION_ID = '01a0b000-0000-7000-8000-000000000712'
const FIXTURE_CWD = '/home/j/work/sample-project'

/** The fixture's three sealed units and their credited tokens (usage-rows.expected.json). */
const UNIT_C = 'msg_01UsageRowsC'
const UNIT_D = 'msg_01UsageRowsD'
const UNIT_E = 'msg_01UsageRowsE'
const TOKENS: Readonly<Record<string, number>> = {
  [UNIT_C]: 5 + 50 + 0 + 1000 + 70,
  [UNIT_D]: 2 + 30 + 1005 + 0 + 0,
  [UNIT_E]: 4 + 12 + 1005 + 10 + 0
}
const ALL_TOKENS = TOKENS[UNIT_C]! + TOKENS[UNIT_D]! + TOKENS[UNIT_E]!

/** Before every record of the fixture: everything it holds is live usage. */
const INSTALL_BEFORE_ALL = 1_790_700_000_000 as Instant
/** Between unit D (11:00:07) and unit E (11:00:22): C and D are history, E is live. */
const INSTALL_BETWEEN_D_AND_E = 1_790_766_010_000 as Instant
/** The Hosts start after the fixture was written. */
const T0 = 1_790_800_000_000 as Instant
const HOUR_MS = 3_600_000

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/** `text` with every JSON-escaped spelling of `from` replaced by `to`. */
function jsonPathSwap(text: string, from: string, to: string): string {
  return text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1))
}

/** A temp root: a home folder with Claude's folders, the mine's folder and the Host database. */
function world(installMomentAt: Instant) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-096-ledger-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const folders = observedProviderFolders({}, join(root, 'home'))
  const cwd = join(root, 'mines', 'sample')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'main.ts'), 'x'.repeat(2_048))
  const project = join(folders.claudeConfigDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  const { db } = openTemplateCopy()
  db.exec(`DELETE FROM install_moment`)
  db.run(`INSERT INTO install_moment (id, at, reason) VALUES (1, ?, 'fresh-install')`, [
    installMomentAt
  ])
  return {
    root,
    folders,
    cwd: cwd as FolderPath,
    db,
    processes: new FakeProcessControl({ bootId: 'boot-a' }),
    /** The Claude session writes its transcript (the fixture, in this mine's folder). */
    writeTranscript: () =>
      writeFileSync(
        join(project, `${SESSION_ID}.jsonl`),
        jsonPathSwap(
          readFileSync(join(FIXTURES, 'claude/observer/2.1.x/usage-rows.jsonl'), 'utf8'),
          FIXTURE_CWD,
          cwd
        )
      )
  }
}
type World = ReturnType<typeof world>

/** The conversation half, played: it stores nothing and holds no event (later: ISSUE-108). */
const STAND_IN_CONVERSATION: ObservedBatchHalf = {
  apply: () => undefined,
  joinedEvents: { publish: () => undefined, discard: () => undefined }
}

/** Every cursor position summed: it moves only when a batch's transaction commits. */
function cursorPosition(db: SqliteDatabase): number {
  return Number(db.all(`SELECT COALESCE(SUM(value), 0) AS total FROM source_cursors`)[0]?.['total'])
}

/**
 * The Host's transaction runner, which can die once right after a commit that moved a cursor:
 * the process ends between the batch commit and anything published after it.
 */
class CrashingRunner implements TransactionRunner, TransactionScope {
  private armed = false
  crashed = false

  constructor(
    private readonly runner: SqliteTransactionRunner,
    private readonly db: SqliteDatabase
  ) {}

  /** The next commit that moves a cursor is the last thing this Host does. */
  arm(): void {
    this.armed = true
  }

  isInTransaction(): boolean {
    return this.runner.isInTransaction()
  }

  inTransaction<T>(work: () => T): T {
    if (this.runner.isInTransaction()) return this.runner.inTransaction(work)
    const before = cursorPosition(this.db)
    const result = this.runner.inTransaction(work)
    if (this.armed && cursorPosition(this.db) !== before) {
      this.armed = false
      this.crashed = true
      throw new Error('the Host died right after the batch commit')
    }
    return result
  }
}

interface RecordedFrame {
  mineId: MineId
  totals: Record<string, { tokens: number }>
  /** Whether a transaction was open when the frame went out. */
  inTransaction: boolean
  /** Where the cursors stood when the frame went out. */
  cursorPosition: number
}

interface HostOptions {
  world: World
  startAt: Instant
  /** What the boot did, in order (TC-096-02). */
  trace?: string[]
  /** The batch transactions' runner; default the plain one. */
  crash?: (runner: SqliteTransactionRunner) => CrashingRunner
}

/**
 * One Host start: the real boot step list, with step 4 wiring the ledger, observation over the
 * `ObservedBatchSink` bridge, crew and mines as host/main.ts does, step 7 starting observation,
 * and the coal backfill after `ready`.
 */
async function bootHost(options: HostOptions) {
  const { db, processes, folders } = options.world
  const { trace } = options
  const clock = new FakeClock(options.startAt)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const record = log.record.bind(log)
  log.record = (entry: DiagnosticEntry) => {
    if (entry.event === 'host.boot.step') trace?.push(`step:${String(entry.causeClass)}`)
    record(entry)
  }
  const epoch = mintBootEpoch(ids)
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  const sections = new SectionRegistry()
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch,
    ids,
    sections,
    snapshotMeta: {
      hostVersion: () => '0.0.0-test',
      state: () => state.current().state,
      resetEpoch: () => 0,
      snapshotTail: () => 20,
      minesEverKnown: () => false
    },
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })
  const servedMines = serveMines({ dispatcher, sections, connections })
  const servedCrew = serveCrew({ dispatcher, sections })

  const transactions = new SqliteTransactionRunner(db)
  const batchRunner = options.crash?.(transactions)
  const bus = new InProcessEventBus<MinesRouteEvent | CrewRouteEvent | LedgerRouteEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  const fs = new NodeFs()
  const frames: RecordedFrame[] = []

  const host: {
    ledger?: WiredLedger
    observation?: WiredObservation
    crew?: WiredCrew
    mines?: WiredMines
  } = {}
  const boot: Promise<BootOutcome> = runBoot(
    (paths) =>
      createBootSteps({
        paths,
        clock,
        scheduler,
        ids,
        fs: new FakeFs(),
        processControl: processes,
        log,
        endpoint: { bind: () => Promise.resolve('bound'), close: () => Promise.resolve() },
        database: { open: () => Promise.resolve() },
        // What host/main.ts does at step 4, over this test's home folder.
        constructModules: () => {
          const ledger = wireLedger({
            repository: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
            transactions,
            bus,
            clock,
            ids,
            hostEpoch: epoch as HostEpoch,
            log,
            frames: {
              publishFrame: (name, data) => {
                if (name !== 'ledger.changed') return
                const { mineId, totals } = data as {
                  mineId: MineId
                  totals: RecordedFrame['totals']
                }
                frames.push({
                  mineId,
                  totals,
                  inTransaction: transactions.isInTransaction(),
                  cursorPosition: cursorPosition(db)
                })
              }
            },
            resolver: createHostGitRepoInspector({ fs, clock }),
            scanner: (resolveMine) => {
              const scanner = new ProviderHistoryScanner({
                fs,
                clock,
                openSnapshot: openReadOnlySnapshot,
                claudeRoots: [folders.claudeConfigDir],
                codexHome: folders.codexHome,
                opencodeStoreRoot: folders.openCodeStoreRoot,
                resolveMine
              })
              return {
                scan: (before, budget, signal) => {
                  trace?.push(`scan:${state.current().state}`)
                  return scanner.scan(before, budget, signal)
                }
              }
            }
          })
          const batches = composeObservedBatchSink({
            transactions: batchRunner ?? transactions,
            ledger: ledger.batchHalf,
            conversation: STAND_IN_CONVERSATION
          })
          const observation = wireObservation({
            stores: createSqliteObservationStores({ db, scope: transactions, clock }),
            ...observationAdapters({
              folders,
              fs,
              clock,
              processes,
              openSnapshot: openReadOnlySnapshot
            }),
            sink: batches.sink,
            transactions: batches.transactions,
            bus,
            fs,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch as HostEpoch,
            log
          })
          const crew = servedCrew.wire({
            db,
            transactions,
            lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch as HostEpoch,
            log,
            links: { owned: () => false, hasDeliveryRoute: () => false },
            processes,
            observation: observation.crew
          })
          const mines = servedMines.wire({
            db,
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            fs,
            hostEpoch: epoch as HostEpoch,
            log,
            mapSites: [],
            random: () => 0,
            scanner: new FsSourceWeightScanner(),
            ...DEFAULT_MINES_SETTINGS,
            crew: crew.mines,
            ledger: ledger.totals
          })
          crew.route({ commands: mines.mines.commands, queries: mines.mines.queries })
          ledger.route({ mines: mines.mines.queries })
          Object.assign(host, { ledger, observation, crew, mines })
        },
        startObservation: () => {
          if (host.observation === undefined) throw new Error('step 7 before step 4')
          host.observation.start?.()
        },
        startModules: () => host.mines?.start()
      }),
    {
      log,
      clock,
      state: {
        report: (report) => {
          trace?.push(`state:${report.state}`)
          state.report(report)
        }
      },
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: options.world.root }) },
      runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
      exit: () => undefined
    }
  )
  expect(await boot).toEqual({ kind: 'ready' })
  const { ledger, observation, crew, mines } = host
  if (
    ledger === undefined ||
    observation === undefined ||
    crew === undefined ||
    mines === undefined
  ) {
    throw new Error('boot step 4 wired no module')
  }
  // After `ready`, as host/main.ts does (S19.02, S19.04).
  const backfill: Promise<BackfillReport | null> = ledger.startBackfill()

  /** Every cycle, route, walk and check the Host started has answered. */
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      await observation.idle()
      await crew.idle()
      await mines.idle()
      await tick()
    }
  }
  /** One poll of the live loop, then everything it caused. */
  const poll = async () => {
    await settle()
    clock.advance(OBSERVATION_POLL_MS)
    await settle()
  }
  /** Declares the world's folder as a mine and lets its first walk measure it (S3.01, S3.09). */
  const measuredMine = async (cwd: FolderPath): Promise<MineId> => {
    const declared = await mines.mines.commands.declare(cwd)
    if (!declared.ok || !('mineId' in declared.value)) throw new Error('the mine was not declared')
    clock.advance(DEFAULT_MINES_SETTINGS.automaticWalkDelayMs)
    await settle()
    return declared.value.mineId
  }
  return {
    clock,
    ledger,
    mines,
    sections,
    frames,
    backfill,
    settle,
    poll,
    measuredMine,
    /** The Host stops (S4.37): its loop ends and nothing more is read. */
    stop: () => observation.observation.control.stop()
  }
}

/** The ledger's entries, by unit key: `[unitKey, material, kind, tokens]`. */
function entries(db: SqliteDatabase): Array<[string, string, string, number]> {
  return db
    .all(`SELECT unit_key, material, kind, tokens FROM ledger_entries ORDER BY unit_key`)
    .map((row) => [
      String(row['unit_key']),
      String(row['material']),
      String(row['kind']),
      Number(row['tokens'])
    ])
}

function tierOf(db: SqliteDatabase, mineId: MineId): string {
  return String(db.all(`SELECT tier FROM mines WHERE id = ?`, [mineId])[0]?.['tier'])
}

/** The mine of the world's folder, as the session's route created it. */
function onlyMine(db: SqliteDatabase): MineId {
  const rows = db.all(`SELECT id FROM mines WHERE removed_at IS NULL`)
  expect(rows).toHaveLength(1)
  return rows[0]!['id'] as MineId
}

describe('the ledger wired into the Host (ISSUE-096)', () => {
  it('[ADR-006] observed usage of a measured mine reaches creditUsage through the ObservedBatchSink bridge, is credited once, and ledger.changed follows the batch commit', async () => {
    const w = world(INSTALL_BEFORE_ALL)
    const host = await bootHost({ world: w, startAt: T0 })
    await host.backfill
    const mineId = await host.measuredMine(w.cwd)
    const tier = tierOf(w.db, mineId)
    expect(tier).not.toBe('null')

    w.writeTranscript()
    await host.poll()
    await host.poll()
    await host.poll()
    host.stop()

    // Each sealed unit once, live, as the mine's tier (INV-91, INV-94).
    expect(entries(w.db)).toEqual(
      [UNIT_C, UNIT_D, UNIT_E].map((unit) => [unit, tier, 'live', TOKENS[unit]])
    )
    expect(host.ledger.ledger.queries.totals(mineId)[tier as 'copper'].tokens).toBe(ALL_TOKENS)
    // `ledger.changed` only after the batch committed: no transaction open, the cursor moved.
    expect(host.frames.length).toBeGreaterThan(0)
    for (const frame of host.frames) {
      expect(frame.mineId).toBe(mineId)
      expect(frame.inTransaction).toBe(false)
      expect(frame.cursorPosition).toBeGreaterThan(0)
    }
    expect(host.frames.at(-1)?.totals[tier]?.tokens).toBe(ALL_TOKENS)
    // The `mines` section reads the same totals (14 §4.1 `MineWire.totals`).
    const section = host.sections.get('mines')?.provider() as Array<{
      id: MineId
      totals: Record<string, { tokens: number }>
    }>
    expect(section.find((mine) => mine.id === mineId)?.totals[tier]?.tokens).toBe(ALL_TOKENS)
  })

  it('[S19.02] the coal backfill starts after ready and credits only history before the install moment', async () => {
    const w = world(INSTALL_BETWEEN_D_AND_E)
    w.writeTranscript()
    // A mine an earlier Host knew: the history of its folder is what the backfill pays.
    const seedTransactions = new SqliteTransactionRunner(w.db)
    const seedClock = new FakeClock(T0)
    await createMines({
      db: w.db,
      transactions: seedTransactions,
      mapSites: [],
      random: () => 0,
      fs: new NodeFs(),
      clock: seedClock,
      ids: new SequenceIdGenerator(),
      bus: new RecordingEventBus({ transactionScope: seedTransactions }),
      hostEpoch: 'epoch-seed' as HostEpoch,
      remeasure: () => undefined
    }).commands.declare(w.cwd)

    const trace: string[] = []
    const host = await bootHost({ world: w, startAt: T0, trace })
    const report = await host.backfill
    await host.settle()
    host.stop()

    expect(report).toMatchObject({ outcome: 'done', scanUnits: 1, unitsCredited: 2 })
    expect(trace.indexOf('state:ready')).toBeGreaterThanOrEqual(0)
    expect(trace.indexOf('state:ready')).toBeLessThan(trace.indexOf('scan:ready'))
    expect(trace.filter((step) => step.startsWith('scan:'))).toEqual(['scan:ready'])
    // C and D are before the moment and paid as coal; E is after it and never coal (09 §5.5).
    expect(
      entries(w.db)
        .filter(([, material]) => material === 'coal')
        .map(([unit, , kind]) => [unit, kind])
    ).toEqual([
      [UNIT_C, 'coal-backfill'],
      [UNIT_D, 'coal-backfill']
    ])
    expect(
      w.db.all(`SELECT backfill_state FROM install_moment WHERE id = 1`)[0]?.['backfill_state']
    ).toBe('done')

    // A later boot finds it done and scans nothing again (S19.05).
    const again: string[] = []
    const second = await bootHost({ world: w, startAt: T0 + HOUR_MS, trace: again })
    expect(await second.backfill).toMatchObject({
      outcome: 'not-run',
      notRunReason: 'already-done'
    })
    second.stop()
    expect(again.filter((step) => step.startsWith('scan:'))).toEqual([])
  })

  it('[S19.04] a paused coal backfill runs again at the next Host ready until it is done', async () => {
    const w = world(INSTALL_BETWEEN_D_AND_E)
    // The OpenCode store cannot be read at the first boot (S19.08): that run ends `paused`.
    mkdirSync(w.folders.openCodeStoreRoot, { recursive: true })
    const store = join(w.folders.openCodeStoreRoot, 'opencode.db')
    writeFileSync(store, 'not a database')

    const trace: string[] = []
    const first = await bootHost({ world: w, startAt: T0, trace })
    expect(await first.backfill).toMatchObject({ outcome: 'paused', unreadableUnits: 1 })
    first.stop()

    rmSync(store)
    const second = await bootHost({ world: w, startAt: T0 + HOUR_MS, trace })
    expect(await second.backfill).toMatchObject({ outcome: 'done' })
    second.stop()
    expect(trace.filter((step) => step.startsWith('scan:'))).toEqual(['scan:ready', 'scan:ready'])
  })

  it('[ADR-006] a crash between a batch commit and its publish credits nothing twice on the next boot', async () => {
    const w = world(INSTALL_BEFORE_ALL)
    let runner: CrashingRunner | undefined
    const first = await bootHost({
      world: w,
      startAt: T0,
      crash: (plain) => (runner = new CrashingRunner(plain, w.db))
    })
    await first.backfill
    await first.measuredMine(w.cwd)
    w.writeTranscript()
    // The session is seen and its dwarf arrives; its batch is read at the next poll.
    await first.poll()
    runner?.arm()
    await first.poll()
    first.stop()
    expect(runner?.crashed).toBe(true)
    // The Host died before anything was published.
    expect(first.frames).toEqual([])

    // The next Host over the same database and the same provider files.
    const second = await bootHost({ world: w, startAt: T0 + HOUR_MS })
    await second.backfill
    await second.poll()
    await second.poll()
    second.stop()

    const tier = tierOf(w.db, onlyMine(w.db))
    expect(entries(w.db)).toEqual(
      [UNIT_C, UNIT_D, UNIT_E].map((unit) => [unit, tier, 'live', TOKENS[unit]])
    )
    expect(second.ledger.ledger.queries.totals(onlyMine(w.db))[tier as 'copper'].tokens).toBe(
      ALL_TOKENS
    )
  })

  it('[INV-95] live observation never credits coal in the composed Host', async () => {
    const w = world(INSTALL_BETWEEN_D_AND_E)
    const host = await bootHost({ world: w, startAt: T0 })
    await host.backfill
    const mineId = await host.measuredMine(w.cwd)
    const tier = tierOf(w.db, mineId)

    // Two units before the install moment and one after, all observed live.
    w.writeTranscript()
    await host.poll()
    await host.poll()
    await host.poll()
    host.stop()

    expect(w.db.all(`SELECT unit_key FROM usage_units ORDER BY unit_key`)).toHaveLength(3)
    expect(entries(w.db)).toEqual([[UNIT_E, tier, 'live', TOKENS[UNIT_E]]])
    expect(host.ledger.ledger.queries.totals(mineId).coal.tokens).toBe(0)
  })

  it('[INV-94] the stored units of a never-measured mine are credited once when MineMeasured arrives', async () => {
    const w = world(INSTALL_BEFORE_ALL)
    w.writeTranscript()
    const host = await bootHost({ world: w, startAt: T0 })
    await host.backfill
    // The session creates its mine (unrecorded) and its usage is read before the first walk.
    await host.poll()
    await host.poll()
    const mineId = onlyMine(w.db)
    expect(tierOf(w.db, mineId)).toBe('null')
    expect(w.db.all(`SELECT unit_key FROM usage_units WHERE sealed = 1`)).toHaveLength(3)
    expect(entries(w.db)).toEqual([])

    // The first walk measures the mine: MineMeasured → creditSealedUnits.
    host.clock.advance(DEFAULT_MINES_SETTINGS.automaticWalkDelayMs)
    await host.settle()
    const tier = tierOf(w.db, mineId)
    expect(entries(w.db)).toEqual(
      [UNIT_C, UNIT_D, UNIT_E].map((unit) => [unit, tier, 'live', TOKENS[unit]])
    )
    const framesAfterMeasure = host.frames.length
    expect(framesAfterMeasure).toBeGreaterThan(0)

    // A second measurement credits none of them again.
    host.mines.walks.remeasure(mineId)
    await host.settle()
    host.stop()
    expect(entries(w.db)).toHaveLength(3)
    expect(host.frames).toHaveLength(framesAfterMeasure)
  })
})
