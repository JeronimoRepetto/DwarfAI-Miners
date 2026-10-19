// layer: L2
// L2 flow (17 §1.2): the cut-1 rollback setting (21 §2 cut 1 row "Rollback", `21-migration-plan.md:172`; §2.1;
// §1 item 4) applied to the Host composition through host/wiring/cut1Rollback.ts, as host/main.ts applies it:
// observation's batch sink and attention's `Level3Sink` are chosen by `cut1RollbackChoices`, step 7 starts
// observation through `WiredObservation.start` and the coal backfill runs through `startBackfillWhenObserving`.
//
// The observer half is the ledger flow's composition (ledger.flow.test.ts, ISSUE-096): the real boot step list, the
// Host dispatcher, one copy of the template database, a FakeClock, FakeScheduler and FakeProcessControl, the ledger,
// observation over the `ObservedBatchSink` bridge (its conversation half played by a stand-in that stores nothing,
// later: ISSUE-108), crew and mines. The provider is Claude, laid out in a per-test temp home folder in its real
// spelling (17 §5.3) with the recorded fixture `fixtures/claude/observer/2.1.x/usage-rows.jsonl` (synthetic,
// scrubbed), whose working folder is rewritten to a real temp folder. The attention half is the module served and
// wired as attentionTransport.ts does it, over the SqliteAttentionLedger of a template database copy, the
// AppBackgroundNotifierLauncher over FakeProcessControl (no app is ever started) and a recording `notifier` connection in the real connection registry (no OS notification is ever
// drawn). No test reads the person's home folder or a provider credential (AGENTS §6).
//
// TC-122-01.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostFrameName } from '@dwarfai/contracts'
import type { DwarfId, FolderPath, HostEpoch, Instant, MineId } from '../../kernel/domain/values'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { AttentionFact } from '../../modules/attention'
import { AppBackgroundNotifierLauncher } from '../../modules/attention/adapters/AppBackgroundNotifierLauncher'
import { SqliteAttentionLedger } from '../../modules/attention/adapters/SqliteAttentionLedger'
import type { BackfillReport } from '../../modules/ledger'
import { ProviderHistoryScanner } from '../../modules/ledger/adapters/ProviderHistoryScanner'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import { createHostGitRepoInspector } from '../../modules/mines/adapters/FsGitRepoInspector'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
import { OBSERVATION_POLL_MS, createSqliteObservationStores } from '../../modules/observation'
import { NodeFs } from '../../platform/fs/NodeFs'
import { openReadOnlySnapshot } from '../../platform/sqlite/readOnlySnapshot'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { TransportLevel3Sink } from '../../transport/attention/TransportLevel3Sink'
import { ConnectionRegistry } from '../../transport/connectionRegistry'
import { createUpgradeDrain } from '../../transport/lifecycle/drain'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import { createUpgradeTargetRule } from '../../transport/methods/hostUpgradeRequest'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { runBoot, type BootOutcome } from '../boot'
import { createBootSteps, mintBootEpoch } from '../bootSteps'
import { composeObservedBatchSink, type ObservedBatchHalf } from '../bridges/observedBatchSink'
import { cut1RollbackChoices } from '../cut1Rollback'
import { emptyDrainGate } from '../emptyDrainGate'
import { createHostDispatcher } from '../hostDispatcher'
import {
  onNotifierAttach,
  serveAttention,
  type AttentionRouteEvent
} from '../routes/attentionTransport'
import { serveCrew, type CrewRouteEvent, type WiredCrew } from '../routes/crew'
import {
  startBackfillWhenObserving,
  wireLedger,
  type LedgerRouteEvent,
  type WiredLedger
} from '../routes/ledger'
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
/** Between unit D (11:00:07) and unit E (11:00:22): C and D are history (coal), E is live usage. */
const INSTALL_BETWEEN_D_AND_E = 1_790_766_010_000 as Instant
/** Before every record of the fixture: everything it holds is live usage. */
const INSTALL_BEFORE_ALL = 1_790_700_000_000 as Instant
/** The Hosts start after the fixture was written. */
const T0 = 1_790_800_000_000 as Instant
const HOUR_MS = 3_600_000

/** What the Host observer writes (09 §4.2, §4.4; 16 §4.3, §4.10): cursors, sessions, usage and ledger credits. */
const OBSERVER_WRITES = [
  'coal_backfill_units',
  'dwarfs',
  'ledger_entries',
  'material_totals',
  'observed_session_streams',
  'observed_sessions',
  'source_cursors',
  'usage_observations',
  'usage_units'
] as const

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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-122-rollback-')))
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
  const lines = jsonPathSwap(
    readFileSync(join(FIXTURES, 'claude/observer/2.1.x/usage-rows.jsonl'), 'utf8'),
    FIXTURE_CWD,
    cwd
  )
    .split('\n')
    .filter((line) => line.trim() !== '')
  const transcript = join(project, `${SESSION_ID}.jsonl`)
  return {
    root,
    folders,
    cwd: cwd as FolderPath,
    db,
    processes: new FakeProcessControl({ bootId: 'boot-a' }),
    /** The Claude session writes the fixture's first `count` records (all of them by default). */
    writeTranscript: (count = lines.length) =>
      writeFileSync(
        transcript,
        lines
          .slice(0, count)
          .map((line) => `${line}\n`)
          .join('')
      )
  }
}
type World = ReturnType<typeof world>

/** The conversation half, played: it stores nothing and holds no event (later: ISSUE-108). */
const STAND_IN_CONVERSATION: ObservedBatchHalf = {
  apply: () => undefined,
  joinedEvents: { publish: () => undefined, discard: () => undefined }
}

/** The Host dispatcher with the doubles every flow of this file hands it. */
function dispatcherFor(deps: {
  log: DiagnosticsLog
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  connections: ConnectionRegistry
  state: HostStateHolder
  sections: SectionRegistry
}) {
  const { log, clock, scheduler, ids, connections, state, sections } = deps
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  return createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch: mintBootEpoch(ids),
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
}

/**
 * One Host start over `world`, with the rollback choices of a build whose setting is `rolledBack`: the real boot
 * step list, step 4 wiring the ledger, observation over the bridge, crew and mines as host/main.ts does, step 7
 * starting observation through `WiredObservation.start`.
 */
async function bootObserverHost(options: { world: World; startAt: Instant; rolledBack: boolean }) {
  const { db, processes, folders } = options.world
  const rollback = cut1RollbackChoices(options.rolledBack)
  const clock = new FakeClock(options.startAt)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const epoch = mintBootEpoch(ids)
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  const sections = new SectionRegistry()
  const dispatcher = dispatcherFor({ log, clock, scheduler, ids, connections, state, sections })
  const servedMines = serveMines({ dispatcher, sections, connections })
  const servedCrew = serveCrew({ dispatcher, sections })

  const transactions = new SqliteTransactionRunner(db)
  const bus = new InProcessEventBus<MinesRouteEvent | CrewRouteEvent | LedgerRouteEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  const fs = new NodeFs()
  const host: {
    ledger?: WiredLedger
    observation?: WiredObservation
    crew?: WiredCrew
    mines?: WiredMines
    sink?: ReturnType<typeof rollback.observedBatchSink>
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
        constructModules: () => {
          const ledger = wireLedger({
            repository: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
            transactions,
            bus,
            clock,
            ids,
            hostEpoch: epoch as HostEpoch,
            log,
            frames: { publishFrame: () => undefined },
            resolver: createHostGitRepoInspector({ fs, clock }),
            scanner: (resolveMine) =>
              new ProviderHistoryScanner({
                fs,
                clock,
                openSnapshot: openReadOnlySnapshot,
                claudeRoots: [folders.claudeConfigDir],
                codexHome: folders.codexHome,
                opencodeStoreRoot: folders.openCodeStoreRoot,
                resolveMine
              })
          })
          const batches = composeObservedBatchSink({
            transactions,
            ledger: ledger.batchHalf,
            conversation: STAND_IN_CONVERSATION
          })
          // What host/main.ts does: the batch sink is the rollback choice's.
          const sink = rollback.observedBatchSink(batches.sink)
          const observation = wireObservation({
            stores: createSqliteObservationStores({ db, scope: transactions, clock }),
            ...observationAdapters({
              folders,
              fs,
              clock,
              processes,
              openSnapshot: openReadOnlySnapshot
            }),
            sink,
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
          Object.assign(host, { ledger, observation, crew, mines, sink })
        },
        // Step 7, as ISSUE-108 composes it: the wiring's own `start`, null while observation writes nothing.
        startObservation: () => {
          if (host.observation === undefined) throw new Error('step 7 before step 4')
          host.observation.start?.()
        },
        startModules: () => host.mines?.start()
      }),
    {
      log,
      clock,
      state,
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: options.world.root }) },
      runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
      exit: () => undefined
    }
  )
  expect(await boot).toEqual({ kind: 'ready' })
  const { ledger, observation, crew, mines, sink } = host
  if (
    ledger === undefined ||
    observation === undefined ||
    crew === undefined ||
    mines === undefined ||
    sink === undefined
  ) {
    throw new Error('boot step 4 wired no module')
  }

  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      await observation.idle()
      await crew.idle()
      await mines.idle()
      await tick()
    }
  }
  return {
    clock,
    /** After `ready`, as host/main.ts does (S19.02): the coal backfill, through the same gate as observation. */
    backfill: (): Promise<BackfillReport | null> | null => startBackfillWhenObserving(ledger, sink),
    /** Declares the world's folder as a mine and lets its first walk measure it (S3.01, S3.09). */
    measuredMine: async (cwd: FolderPath): Promise<MineId> => {
      const declared = await mines.mines.commands.declare(cwd)
      if (!declared.ok || !('mineId' in declared.value))
        throw new Error('the mine was not declared')
      clock.advance(DEFAULT_MINES_SETTINGS.automaticWalkDelayMs)
      await settle()
      return declared.value.mineId
    },
    /** One poll of the live loop, then everything it caused. */
    poll: async () => {
      await settle()
      clock.advance(OBSERVATION_POLL_MS)
      await settle()
    },
    /** The Host stops (S4.37): its loop ends and nothing more is read. */
    stop: () => observation.observation.control.stop()
  }
}

/** The rows of every table the Host observer writes, for "what did this Host write" comparisons. */
function observerRows(db: SqliteDatabase): Record<string, unknown[]> {
  return Object.fromEntries(
    OBSERVER_WRITES.map((table) => [
      table,
      db
        .all(`SELECT * FROM "${table}"`)
        .map((row) => (table === 'source_cursors' ? { ...row, updated_at: null } : row))
    ])
  )
}

function rowCount(db: SqliteDatabase, table: (typeof OBSERVER_WRITES)[number]): number {
  return Number(db.all(`SELECT COUNT(*) AS n FROM "${table}"`)[0]?.['n'])
}

const DWARF = '00000000-0000-7000-8000-0000000122d1' as DwarfId
const MINE = '00000000-0000-7000-8000-0000000122a1' as MineId

/**
 * Attention served and wired as host/main.ts does it, with the level-3 sink the rollback choice of a build whose
 * setting is `rolledBack` returns over `TransportLevel3Sink`, and one recording `notifier` attached.
 */
function wireAttentionHost(rolledBack: boolean) {
  const rollback = cut1RollbackChoices(rolledBack)
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  const sections = new SectionRegistry()
  const dispatcher = dispatcherFor({ log, clock, scheduler, ids, connections, state, sections })
  const served = serveAttention({ dispatcher, connections })
  const frames: HostFrameName[] = []
  connections.attach({
    role: 'notifier',
    clientId: 'notifier-1',
    send: (name) => void frames.push(name),
    end: () => Promise.resolve()
  })
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  // One mine and its present dwarf, whose attention keys the ledger records.
  transactions.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/moria', 'moria', 'moria', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at)
       VALUES (?, ?, 'claude', 'session-a', 'Gimli', 'foreman', 'running', 'none-yet', ?, ?)`,
      [DWARF, MINE, T0, T0]
    )
  })
  const bus = new InProcessEventBus<AttentionRouteEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  const hostEpoch = mintBootEpoch(ids) as HostEpoch
  const wired = served.wire({
    ledger: new SqliteAttentionLedger({ db, scope: transactions, clock, hostEpoch }),
    // What host/main.ts does: the level-3 sink is the rollback choice's.
    sink: rollback.level3Sink(new TransportLevel3Sink(connections), log),
    // A notifier is attached, so nothing is ever started; FakeProcessControl stands for the OS.
    launcher: new AppBackgroundNotifierLauncher({
      processes: new FakeProcessControl({ clock }),
      paths: new FakeAppPaths({ execPath: 'fake-install/DwarfAI-Miners' }),
      env: {},
      scheduler,
      onNotifierAttach: onNotifierAttach(connections)
    }),
    preferences: {
      get: () =>
        ({ systemNotificationsOn: true }) as ReturnType<
          Parameters<typeof served.wire>[0]['preferences']['get']
        >
    },
    transactions,
    bus,
    clock,
    scheduler,
    ids,
    hostEpoch,
    log
  })
  /** An open question of the dwarf, nothing on screen: a level-3 notification by ADR-018. */
  const question = (n: number): AttentionFact => {
    const askId = `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
    transactions.inTransaction(() =>
      db.run(
        `INSERT OR IGNORE INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json,
           state, opened_at)
         VALUES (?, ?, 'question', 'driver', ?, '{}', 'open', ?)`,
        [askId, DWARF, `request-${askId}`, clock.now()]
      )
    )
    return {
      key: `${DWARF}:question:${askId}`,
      kind: 'question',
      dwarfId: DWARF,
      mineId: MINE,
      at: clock.now(),
      reannounce: true
    }
  }
  return { attention: wired.attention, frames, log, question }
}

describe('the cut-1 rollback setting (21 §2 cut 1 "Rollback", ISSUE-122)', () => {
  it('[ADR-001] with the cut-1 rollback setting on, the Host observer writes no session, usage or ledger credit for new transcript records', async () => {
    const w = world(INSTALL_BETWEEN_D_AND_E)
    const host = await bootObserverHost({ world: w, startAt: T0, rolledBack: true })
    await host.measuredMine(w.cwd)
    const before = observerRows(w.db)

    w.writeTranscript()
    for (let i = 0; i < 3; i += 1) await host.poll()
    // The coal backfill credits history: with the setting on it never runs either.
    const backfill = host.backfill()
    await backfill
    host.clock.advance(HOUR_MS)
    await host.poll()
    host.stop()

    expect(rowCount(w.db, 'observed_sessions')).toBe(0)
    expect(rowCount(w.db, 'ledger_entries')).toBe(0)
    expect(observerRows(w.db)).toEqual(before)
    expect(backfill).toBeNull()
  })

  it('[ADR-001] with the setting on, an attention fact produces no attention.notify frame', () => {
    const h = wireAttentionHost(true)

    h.attention.inputs.onFact(h.question(1), { displayName: 'Gimli', mineName: 'Moria' })
    h.attention.inputs.onFactEnded(h.question(1).key)

    expect(h.frames).toEqual([])
    // The decision is still logged, by its event name only: no title, body or name (ADR-026; 19 §9).
    expect(h.log.byEvent('attention.decision')).toEqual([
      {
        level: 'debug',
        event: 'attention.decision',
        subsystem: 'attention',
        dwarfId: DWARF,
        causeClass: 'question',
        outcome: 'skipped'
      }
    ])
    expect(h.log.refused).toEqual([])
  })

  it('[ADR-001] with the setting on, rows the Host wrote before remain readable (forward-only)', async () => {
    const w = world(INSTALL_BEFORE_ALL)
    // The faulty cut-1 build: the Host observed and credited the first records.
    const first = await bootObserverHost({ world: w, startAt: T0, rolledBack: false })
    await first.measuredMine(w.cwd)
    w.writeTranscript(7)
    for (let i = 0; i < 3; i += 1) await first.poll()
    first.stop()
    const written = observerRows(w.db)
    expect(rowCount(w.db, 'observed_sessions')).toBeGreaterThan(0)
    expect(rowCount(w.db, 'ledger_entries')).toBeGreaterThan(0)

    // The rollback build, upgraded into over the same database: the provider goes on writing.
    const rolledBack = await bootObserverHost({
      world: w,
      startAt: (T0 + HOUR_MS) as Instant,
      rolledBack: true
    })
    w.writeTranscript()
    for (let i = 0; i < 3; i += 1) await rolledBack.poll()
    rolledBack.clock.advance(HOUR_MS)
    await rolledBack.poll()
    rolledBack.stop()

    // Nothing deleted, nothing added: what the faulty build wrote stays, and nothing new is written.
    expect(observerRows(w.db)).toEqual(written)
  })

  it('[ADR-001] with the setting off (the normal build) both paths work', async () => {
    const w = world(INSTALL_BETWEEN_D_AND_E)
    const host = await bootObserverHost({ world: w, startAt: T0, rolledBack: false })
    await host.measuredMine(w.cwd)
    w.writeTranscript()
    for (let i = 0; i < 3; i += 1) await host.poll()
    const backfill = host.backfill()
    expect(backfill).not.toBeNull()
    await backfill
    host.stop()
    expect(rowCount(w.db, 'observed_sessions')).toBeGreaterThan(0)
    expect(rowCount(w.db, 'ledger_entries')).toBeGreaterThan(0)

    const h = wireAttentionHost(false)
    h.attention.inputs.onFact(h.question(1), { displayName: 'Gimli', mineName: 'Moria' })
    expect(h.frames).toEqual(['attention.notify'])
  })
})
