// layer: L2
// L2 flow (17 §1.2): the observation module wired into the Host (05 §4; 16 §8.2, §8.3) through
// host/wiring/routes/observation.ts, as host/main.ts wires it: at boot step 4 the module over the
// three SQLite stores it shares with crew's index, the four provider adapters of 15 §5 and its
// provider-error route, then crew (with observation's process identities and `recordEnded`) and
// mines and their 05 §4 routes; at step 7 `catchUp()` then `start()`. The real boot step list, the
// Host dispatcher, one copy of the template database, a FakeClock, FakeScheduler and
// FakeProcessControl (the kernel probe the Claude adapter's #45 guard reads, and the tree kill of
// the `SessionTerminator` bridge).
//
// The providers are laid out in a per-test temp home folder in their real spelling (17 §5.3), each
// holding one recorded fixture session of `fixtures/<provider>/observer/**` (synthetic, scrubbed),
// whose working folder is rewritten to a real temp folder: mines resolves a cwd on the real disk.
// No test reads the person's home folder or a provider credential (AGENTS §6).
//
// TC-095-01, TC-095-02, TC-095-03.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../kernel/domain/processIdentity'
import type {
  DwarfId,
  EventId,
  FolderPath,
  HostEpoch,
  Instant,
  ProviderIdentity
} from '../../kernel/domain/values'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import type { DiagnosticEntry } from '../../kernel/ports/diagnosticsLog'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { FsSourceWeightScanner } from '../../modules/mines/adapters/FsSourceWeightScanner'
import { OBSERVATION_POLL_MS, createSqliteObservationStores } from '../../modules/observation'
import { NodeFs } from '../../platform/fs/NodeFs'
import { NodeSqliteDatabase } from '../../platform/sqlite/NodeSqliteDatabase'
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
import { emptyDrainGate } from '../emptyDrainGate'
import { createHostDispatcher } from '../hostDispatcher'
import { serveCrew, type CrewRouteEvent, type WiredCrew } from '../routes/crew'
import {
  DEFAULT_MINES_SETTINGS,
  serveMines,
  type MinesRouteEvent,
  type WiredMines
} from '../routes/mines'
import {
  PROVIDER_ERROR_EVENT,
  noObservedBatchSinkYet,
  observationAdapters,
  observedProviderFolders,
  wireObservation,
  type WiredObservation
} from '../routes/observation'

const T0 = 1_790_800_000_000
const HOUR_MS = 3_600_000
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures')

/** The Claude registry's pid and its recorded start (`procStart`, a FILETIME, in epoch ms). */
const CLAUDE_PROCESS: ProcessIdentity = {
  pid: 32896,
  processStartTimeMs: 1_788_001_972_136,
  bootId: 'boot-a'
}

/** One recorded session per observed provider: its identity and the folder it works in. */
const SESSIONS = {
  claude: { providerId: 'claude', providerSessionId: '01a0b000-0000-7000-8000-000000000711' },
  codex: { providerId: 'codex', providerSessionId: '01a0b000-0000-7000-8000-000000000731' },
  antigravity: {
    providerId: 'antigravity',
    providerSessionId: '11111111-1111-4111-8111-111111111111'
  },
  opencode: { providerId: 'opencode', providerSessionId: 'ses_parts_0003' }
} as const satisfies Record<string, ProviderIdentity>
type Provider = keyof typeof SESSIONS

/** The tables the observation module owns (09 §4.2; INV-37). */
const OBSERVATION_TABLES = [
  'ended_agents',
  'observed_session_streams',
  'observed_sessions',
  'source_cursors'
]

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function fixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8')
}

/** `text` with every JSON-escaped spelling of `from` replaced by `to`. */
function jsonPathSwap(text: string, from: string, to: string): string {
  return text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1))
}

/**
 * A home folder holding the four providers' data in their real spelling, each with one fixture
 * session working in its own real folder under `root`. Returns the folders and the Claude
 * transcript.
 */
function layOutProviders(root: string) {
  const home = join(root, 'home')
  const folders = observedProviderFolders({}, home)
  const cwdOf = (provider: Provider): string => {
    const folder = join(root, 'mines', provider)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'main.ts'), 'x'.repeat(2_048))
    return folder
  }

  // Claude: projects/<encoded cwd>/<sessionId>.jsonl, and the session registry (15 §5).
  const claudeCwd = cwdOf('claude')
  const project = join(folders.claudeConfigDir, 'projects', claudeCwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  const claudeTranscript = join(project, `${SESSIONS.claude.providerSessionId}.jsonl`)
  writeFileSync(
    claudeTranscript,
    jsonPathSwap(
      fixture('claude/observer/2.1.x/plain-session.jsonl'),
      'C:\\Users\\j\\work\\sample.project',
      claudeCwd
    )
  )
  mkdirSync(join(folders.claudeConfigDir, 'sessions'), { recursive: true })
  writeFileSync(
    join(folders.claudeConfigDir, 'sessions', `${CLAUDE_PROCESS.pid}.json`),
    fixture('claude/observer/2.1.x/session-registry.json')
  )

  // Codex: sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl.
  const sampleProject = 'C:\\Users\\j\\Desktop\\Sample-Project'
  const codexCwd = cwdOf('codex')
  const rollouts = join(folders.codexHome, 'sessions', '2026', '09', '30')
  mkdirSync(rollouts, { recursive: true })
  writeFileSync(
    join(rollouts, 'rollout-2026-09-30T00-00-00-turn-with-usage.jsonl'),
    jsonPathSwap(fixture('codex/observer/0.153.x/turn-with-usage.jsonl'), sampleProject, codexCwd)
  )

  // Antigravity: the agy tree's step log, history and presence lock.
  const antigravityCwd = cwdOf('antigravity')
  const cid = SESSIONS.antigravity.providerSessionId
  const tree = join(folders.geminiDir, 'antigravity-cli')
  const logs = join(tree, 'brain', cid, '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  writeFileSync(
    join(logs, 'transcript.jsonl'),
    fixture('antigravity/observer/1.1.26/transcript.jsonl')
  )
  writeFileSync(
    join(tree, 'history.jsonl'),
    jsonPathSwap(
      fixture('antigravity/observer/1.1.26/history.jsonl'),
      sampleProject,
      antigravityCwd
    )
  )
  mkdirSync(join(tree, 'presence'), { recursive: true })
  writeFileSync(join(tree, 'presence', `${cid}.lock`), '')

  // OpenCode: opencode.db built from the schema and the messages-and-parts case.
  const openCodeCwd = cwdOf('opencode')
  mkdirSync(folders.openCodeStoreRoot, { recursive: true })
  const store = NodeSqliteDatabase.open(join(folders.openCodeStoreRoot, 'opencode.db'))
  store.exec(fixture('opencode/observer/1.18.x/schema.sql'))
  store.exec(
    fixture('opencode/observer/1.18.x/messages-and-parts.sql')
      .split("'/home/j/work/sample-project'")
      .join(`'${openCodeCwd.replace(/'/g, "''")}'`)
  )
  store.close()

  return { folders, claudeTranscript }
}

/**
 * Every row of every table, for "what did this write" comparisons. A cursor's `updated_at` is when
 * it was last read (09 §4.2), which every cycle stamps; its position (`value`) is what moves.
 */
function dumpTables(db: SqliteDatabase): Map<string, string> {
  const names = db
    .all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .map((row) => String(row['name']))
  const rowsOf = (name: string) =>
    db
      .all(`SELECT * FROM "${name}"`)
      .map((row) => (name === 'source_cursors' ? { ...row, updated_at: null } : row))
  return new Map(names.map((name) => [name, JSON.stringify(rowsOf(name))]))
}

/** A statement that writes, and the table it writes (an upsert's `DO UPDATE SET` names none). */
const WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|(?<!DO\s+)UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+"?(\w+)"?/gi

/** `db`, noting in `tables` the table of every statement written through it (INV-37). */
function recordingWrites(db: SqliteDatabase, tables: Set<string>): SqliteDatabase {
  const note = (sql: string) => {
    for (const match of sql.matchAll(WRITE)) tables.add(String(match[1]).toLowerCase())
  }
  return {
    exec: (sql) => {
      note(sql)
      db.exec(sql)
    },
    run: (sql, params) => {
      note(sql)
      return db.run(sql, params)
    },
    all: (sql, params) => {
      note(sql)
      return db.all(sql, params)
    },
    openReader: () => db.openReader(),
    close: () => db.close()
  }
}

function changedTables(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([name, rows]) => before.get(name) !== rows).map(([name]) => name)
}

interface HostOptions {
  db: SqliteDatabase
  root: string
  folders: ReturnType<typeof observedProviderFolders>
  processes: FakeProcessControl
  startAt: Instant
  /** What the boot did, in order (TC-095-02). */
  trace?: string[]
  /** Where the tables the observation module writes are noted (INV-37). */
  observationWrites?: Set<string>
}

/**
 * One Host start: the real boot step list, with step 4 wiring observation, crew and mines over
 * the database as host/main.ts does, and step 7 starting observation.
 */
async function bootHost(options: HostOptions) {
  const { db, processes, trace } = options
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
  const bus = new InProcessEventBus<MinesRouteEvent | CrewRouteEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  const fs = new NodeFs()

  const host: { observation?: WiredObservation; crew?: WiredCrew; mines?: WiredMines } = {}
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
          // The module reaches the database only through its stores (INV-37).
          const stores = createSqliteObservationStores({
            db:
              options.observationWrites === undefined
                ? db
                : recordingWrites(db, options.observationWrites),
            scope: transactions,
            clock
          })
          const observation = wireObservation({
            stores,
            ...observationAdapters({
              folders: options.folders,
              fs,
              clock,
              processes,
              openSnapshot: openReadOnlySnapshot
            }),
            sink: noObservedBatchSinkYet,
            transactions,
            bus,
            fs,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch as HostEpoch,
            log
          })
          if (trace !== undefined) {
            const control = observation.observation.control
            const catchUp = control.catchUp.bind(control)
            const start = control.start.bind(control)
            control.catchUp = async () => {
              trace.push('catchUp')
              await catchUp()
              trace.push(`catchUp:done:${state.current().state}`)
            }
            control.start = () => {
              trace.push('start')
              start()
            }
            bus.subscribe('SessionObserved', () => trace.push('observed'))
          }
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
            crew: crew.mines
          })
          crew.route({ commands: mines.mines.commands, queries: mines.mines.queries })
          host.observation = observation
          host.crew = crew
          host.mines = mines
        },
        startObservation: () => {
          if (host.observation === undefined) throw new Error('step 7 before step 4')
          host.observation.start()
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
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: options.root }) },
      runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
      exit: () => undefined
    }
  )
  expect(await boot).toEqual({ kind: 'ready' })
  const { observation, crew, mines } = host
  if (observation === undefined || crew === undefined || mines === undefined) {
    throw new Error('boot step 4 wired no module')
  }

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
  const envelope = () => ({
    v: 1 as const,
    id: ids.uuidv7() as EventId,
    at: clock.now(),
    hostEpoch: epoch as HostEpoch
  })
  return {
    clock,
    bus,
    log,
    observation,
    crew,
    mines,
    settle,
    poll,
    envelope,
    /** The Host stops (S4.37): its loop ends and nothing more is read. */
    stop: () => observation.observation.control.stop()
  }
}

/** A temp root with the four providers laid out, its database and the kernel's process fake. */
function world() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-095-observation-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const { folders, claudeTranscript } = layOutProviders(root)
  const processes = new FakeProcessControl({ bootId: CLAUDE_PROCESS.bootId })
  processes.scriptTree({ ...CLAUDE_PROCESS })
  const { db } = openTemplateCopy()
  return { root, folders, claudeTranscript, processes, db }
}

/** The dwarfs of the Host database, by provider identity. */
function dwarfRows(db: SqliteDatabase) {
  return db
    .all(
      `SELECT id, provider_id, provider_session_id, departed_at FROM dwarfs ORDER BY provider_id`
    )
    .map((row) => ({
      id: row['id'] as DwarfId,
      providerId: row['provider_id'],
      providerSessionId: row['provider_session_id'],
      departed: row['departed_at'] !== null
    }))
}

describe('observation wired into the Host (ISSUE-095)', () => {
  it("[ADR-006] each provider's fixture sessions produce their dwarfs once and a second boot adds nothing", async () => {
    const w = world()
    const first = await bootHost({ ...w, startAt: T0 })
    await first.poll()
    // Every mine's first measurement (its scoring walk) is done before the Host stops.
    first.clock.advance(DEFAULT_MINES_SETTINGS.automaticWalkDelayMs)
    await first.poll()
    first.stop()

    const sessions = Object.values(SESSIONS)
    expect(dwarfRows(w.db).map((d) => [d.providerId, d.providerSessionId, d.departed])).toEqual(
      sessions
        .map((s) => [s.providerId, s.providerSessionId, false])
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
    )
    expect(w.db.all(`SELECT id FROM mines WHERE removed_at IS NULL`)).toHaveLength(4)
    expect(
      w.db.all(`SELECT id FROM dwarf_lifecycle_facts WHERE type = 'DwarfArrived'`)
    ).toHaveLength(4)

    // A second Host over the same database and the same provider files.
    const before = dumpTables(w.db)
    const second = await bootHost({ ...w, startAt: first.clock.now() + HOUR_MS })
    await second.poll()
    await second.poll()
    second.stop()

    expect(changedTables(before, dumpTables(w.db))).toEqual([])
  })

  it('[ADR-002] catchUp runs after recovery and before start, and hello answers ready only after the classification', async () => {
    const w = world()
    const trace: string[] = []
    const host = await bootHost({ ...w, startAt: T0, trace })
    await host.settle()
    host.stop()

    // Recovery's classification (step 5) precedes the catch-up, the catch-up the live loop, and
    // `ready` follows step 7 …
    const at = (marker: string) => trace.indexOf(marker)
    expect(at('step:recover-sessions')).toBeGreaterThanOrEqual(0)
    expect(at('step:recover-sessions')).toBeLessThan(at('catchUp'))
    expect(at('catchUp')).toBeLessThan(at('start'))
    expect(at('start')).toBeLessThan(at('step:start-observation'))
    expect(at('step:start-observation')).toBeLessThan(at('state:ready'))
    // … without waiting for the pass, which goes on after `ready` (16 §4.3 `catchUp`): before
    // `ready` only the classification. Every session it found is observed all the same.
    expect(at('state:ready')).toBeLessThan(at('catchUp:done:ready'))
    expect(trace.filter((marker) => marker === 'observed')).toHaveLength(4)
  })

  it('[INV-36] a session ended by the wired terminator is not observed again', async () => {
    const w = world()
    const host = await bootHost({ ...w, startAt: T0 })
    await host.poll()
    const claude = dwarfRows(w.db).find((d) => d.providerId === 'claude')
    if (claude === undefined) throw new Error('the Claude session made no dwarf')
    const mineId = host.crew.crew.queries.get(claude.id)?.mineId
    if (mineId === undefined) throw new Error('the Claude dwarf has no mine')

    // Remove mine ends the dwarf through crew's ends over the wired terminator (ADR-014).
    const ends = await host.crew.mines.ends.endAllIn(mineId, 'request-095')
    await host.settle()
    expect(ends).toEqual({ ended: [claude.id], failed: [] })
    expect(w.processes.signals.map((s) => s.pid)).toContain(CLAUDE_PROCESS.pid)
    let observedAgain = 0
    host.bus.subscribe('SessionObserved', ({ payload }) => {
      if (payload.identity.providerId === 'claude') observedAgain += 1
    })

    // The provider keeps writing to the ended session's transcript.
    const last = readFileSync(w.claudeTranscript, 'utf8').trimEnd().split(/\r?\n/).at(-1) ?? ''
    const late = JSON.parse(last) as Record<string, unknown>
    appendFileSync(
      w.claudeTranscript,
      `${JSON.stringify({ ...late, uuid: '00000000-0000-4000-8000-0000000711ff' })}\n`
    )
    await host.poll()
    await host.poll()
    host.stop()

    const rows = dwarfRows(w.db).filter((d) => d.providerId === 'claude')
    expect(rows).toEqual([{ ...claude, departed: true }])
    expect(
      w.db.all(`SELECT provider_session_id FROM ended_agents WHERE provider_id = 'claude'`)
    ).toEqual([{ provider_session_id: SESSIONS.claude.providerSessionId }])
    expect(observedAgain).toBe(0)
  })

  it('[INV-37] the composed observation writes only its own tables', async () => {
    const w = world()
    const written = new Set<string>()
    const host = await bootHost({ ...w, startAt: T0, observationWrites: written })
    await host.poll()
    await host.poll()
    host.stop()

    // The routes made the mines and dwarfs through their own modules …
    expect(dwarfRows(w.db)).toHaveLength(4)
    // … while the module wrote its cursors and its index, and nothing else (09 §4.2).
    expect([...written].sort()).toEqual(
      expect.arrayContaining(['observed_sessions', 'source_cursors'])
    )
    expect([...written].filter((table) => !OBSERVATION_TABLES.includes(table))).toEqual([])
  })

  it('[S1.08] an observed turn start reaches the composed crew and makes its idle dwarf working', async () => {
    const w = world()
    const host = await bootHost({ ...w, startAt: T0 })
    await host.poll()
    const cwd = join(w.root, 'mines', 'claude') as FolderPath
    const identity: ProviderIdentity = { providerId: 'claude', providerSessionId: 'later-session' }

    // A second session in the known mine, with no message yet: it arrives idle (PO #14).
    host.bus.publish({
      type: 'SessionObserved',
      ...host.envelope(),
      payload: { identity, cwd, streamId: 'stream-later', firstMessage: false }
    })
    await host.settle()
    const dwarfId = w.db.all(`SELECT id FROM dwarfs WHERE provider_session_id = ?`, [
      identity.providerSessionId
    ])[0]?.['id'] as DwarfId | undefined
    if (dwarfId === undefined) throw new Error('the later session made no dwarf')
    expect(host.crew.crew.statusTimer.statusOf(dwarfId)).toBe('idle')

    host.bus.publish({
      type: 'SessionActivityObserved',
      ...host.envelope(),
      payload: { identity, sourceKey: 'claude:later:1', at: host.clock.now(), kind: 'turn-started' }
    })
    await host.settle()
    host.stop()

    expect(host.crew.crew.statusTimer.statusOf(dwarfId)).toBe('working')
  })

  it('[ADR-026] a provider error of an observed dwarf is logged once with its cause class and ids only', async () => {
    const w = world()
    const host = await bootHost({ ...w, startAt: T0 })
    await host.poll()
    const claude = dwarfRows(w.db).find((d) => d.providerId === 'claude')
    if (claude === undefined) throw new Error('the Claude session made no dwarf')

    host.bus.publish({
      type: 'ProviderErrorObserved',
      ...host.envelope(),
      payload: { providerId: 'claude', cause: 'unreadable', dwarfId: claude.id }
    })
    await host.settle()
    host.stop()

    expect(host.log.byEvent(PROVIDER_ERROR_EVENT)).toEqual([
      {
        level: 'warn',
        event: PROVIDER_ERROR_EVENT,
        subsystem: 'observation',
        provider: 'claude',
        causeClass: 'unreadable',
        dwarfId: claude.id,
        outcome: 'failed',
        msg: 'a provider of an observed session errored or became unreadable'
      }
    ])
    expect(host.log.refused.filter((r) => r.entry.event === PROVIDER_ERROR_EVENT)).toEqual([])
  })
})
