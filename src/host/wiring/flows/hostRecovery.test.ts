// layer: L2
// L2 flow (17 §1.2, §1.10 CH-01; 11 F7; UC-025; ADR-015 items 3–5, 7): the Host stops unexpectedly
// and a new Host composition starts over the same stored rows. Host A's launch is written as the
// launch use case writes it (testing/launchRecording.ts: `launches`, `processes`, `launch_records`)
// and its dwarf arrives through crew; Host B is a new launching module over the same in-memory
// launching stores and the same crew rows (the "database"), the same FakeProcessControl state (the
// OS), a resumable driver double (the provider CLI), FakeClock and FakeScheduler. Its recovery pass
// runs as boot step 5 runs it: classification first, then the spaced resumes. No real time, no
// process, no disk, except the template database of the delivery-reconcile case.
//
// TC-173-02 (no LaunchedSessionCrashed, no HostRecovered and no departure after a crash with every
// session resumable) and TC-173-03 (a reboot resumes nothing and lists nothing).
import { describe, expect, it } from 'vitest'
import type { PreviousEpochEnd } from '../../kernel/domain/bootIdentity'
import type { ProcessIdentity } from '../../kernel/domain/processIdentity'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  Instant,
  LaunchId,
  MineId,
  ProviderId
} from '../../kernel/domain/values'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import { createConversation } from '../../modules/conversation'
import {
  seedConversationDb,
  sqliteProbe
} from '../../modules/conversation/testing/sqliteConversationDb'
import { rankForDepth } from '../../modules/crew'
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import {
  createLaunching,
  RESUME_SPACING_MS,
  type Launch,
  type LaunchingEvent,
  type LaunchRecord
} from '../../modules/launching'
import { InMemoryRecoveryReportStore } from '../../modules/launching/testing/InMemoryRecoveryReportStore'
import { inMemoryLaunching } from '../../modules/launching/testing/inMemoryLaunching'
import { launchRecording } from '../../modules/launching/testing/launchRecording'
import { ResumableDriver, type ResumeAnswer } from '../../modules/launching/testing/ResumableDriver'
import type {
  DriverTransport,
  ProviderCapabilities,
  ProviderDriver,
  SessionRef
} from '../../modules/suppliers'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'

const T0 = 1_790_000_000_000
const EPOCH_A = 'epoch-173-a' as HostEpoch
const EPOCH_B = 'epoch-173-b' as HostEpoch
const MINE = '00000000-0000-7000-8000-0000000173f1' as MineId
const FOLDER = '/work/deep-seam' as FolderPath
const PROVIDER = 'claude' as ProviderId
const BOOT = 'boot-173'
const CRASHED: PreviousEpochEnd = { kind: 'crashed', rule: 'none' }

interface Owned {
  dwarfId: DwarfId
  launchId: LaunchId
  process: ProcessIdentity
  record: LaunchRecord
}

/** The stored rows and the OS a stopped Host leaves behind, and Host B composed over them. */
function world(opts: { adopt?: boolean; resumeMs?: number; transport?: DriverTransport } = {}) {
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const crew = inMemoryCrew()
  const os = new FakeProcessControl({ bootId: BOOT, clock })
  const recording = launchRecording(db)
  const ids = new SequenceIdGenerator()
  let pid = 7_300

  /** Host A: one launch written as the launch use case writes it, its dwarf arrived through crew. */
  const launched = (
    n: number,
    status: 'working' | 'idle' = 'idle',
    purpose: 'session' | 'session-server' = 'session'
  ): Owned => {
    // The launch as `requestLaunch` writes it (S5.11): a supplier launch, `resolving`.
    const launch: Launch = {
      id: ids.uuidv7() as LaunchId,
      request: {
        mineId: MINE,
        way: { kind: 'supplier', providerId: PROVIDER },
        prompt: `Task ${n}`,
        jevOn: false,
        jevAutoAccept: false
      },
      state: 'resolving',
      hostEpoch: EPOCH_A,
      launchedWithLetJevChoose: false
    }
    const process: ProcessIdentity = {
      pid: (pid += 1),
      processStartTimeMs: T0 - 5_000,
      bootId: BOOT
    }
    const ref: SessionRef = { providerId: PROVIDER, providerSessionId: `session-${n}` }
    const dwarfId = crew.commands.arrive({
      mineId: MINE,
      identity: { providerId: PROVIDER, providerSessionId: ref.providerSessionId },
      rank: rankForDepth(0),
      status
    })
    const requested = recording.requested(launch)
    if (purpose === 'session-server') {
      // A shared server's process is recorded with its own purpose (ADR-015 item 1).
      db.inTransaction(() =>
        db.processes.put({ identity: process, purpose, launchId: requested.id, hostEpoch: EPOCH_A })
      )
    }
    const spawned = recording.spawned(requested, process, T0 - 5_000)
    const record: LaunchRecord = {
      dwarfId,
      launchId: spawned.id,
      ref,
      driverTransport: opts.transport ?? 'stream-json',
      cwd: FOLDER,
      launchOptions: { providerId: PROVIDER },
      launchedWithLetJevChoose: false,
      process,
      resumeIntent: true,
      stoppedByPerson: false,
      hostEpoch: EPOCH_A
    }
    recording.handshaken(spawned, dwarfId, record)
    return { dwarfId, launchId: spawned.id, process, record }
  }

  /** Host B over the same rows: launching with its recovery pass, as host/main.ts binds it. */
  const restart = (
    deps: {
      previous?: PreviousEpochEnd | null
      resume?: 'cli-flag' | 'none'
      deliveries?: (dwarfIds: readonly DwarfId[]) => Promise<Map<DwarfId, string[]>>
    } = {}
  ) => {
    const bus = new RecordingEventBus<LaunchingEvent>()
    const log = new RecordingDiagnosticsLog()
    const resumable = new ResumableDriver({
      providerId: PROVIDER,
      ...(opts.transport === undefined ? {} : { transport: opts.transport }),
      clock,
      scheduler,
      resumeMs: opts.resumeMs ?? 50,
      adopt: opts.adopt ?? false,
      pids: [9_001, 9_002, 9_003, 9_004]
    })
    for (const next of [9_001, 9_002, 9_003, 9_004]) {
      os.script(next, { pid: next, processStartTimeMs: T0, bootId: BOOT })
    }
    const bound: Array<{ ref: SessionRef; dwarfId: DwarfId }> = []
    const drivers: ProviderDriver[] = [resumable.driver]
    let open = false
    const transactions: TransactionRunner = {
      inTransaction: <T>(work: () => T): T => {
        if (open) return work()
        open = true
        try {
          return db.inTransaction(work)
        } finally {
          open = false
        }
      }
    }
    const reports = new InMemoryRecoveryReportStore({ isInTransaction: () => open })
    const launching = createLaunching({
      launches: db.launches,
      processes: db.processes,
      records: db.records,
      transactions,
      starter: {
        start: () => {
          throw new Error('Host B launches nothing')
        }
      },
      suppliers: {
        registry: { drivers: (id) => (id === PROVIDER ? drivers : []) },
        catalogue: { entry: () => null },
        bindings: { bind: (ref, dwarfId) => bound.push({ ref, dwarfId }) }
      },
      mines: { get: () => null, folderOf: () => FOLDER },
      crew: crew.commands,
      bus,
      clock,
      scheduler,
      ids,
      hostEpoch: EPOCH_B,
      installId: 'install-173',
      log
    })
    const recovery = launching.recovery({
      reports,
      previousEpochEnd: () => (deps.previous === undefined ? CRASHED : deps.previous),
      processControl: os,
      crew: {
        markUnrecovered: (id) => crew.commands.markUnrecovered(id),
        rebind: (id, next) => crew.commands.rebind(id, next),
        sessionClosed: (id, cause) => crew.commands.sessionClosed(id, cause),
        get: (id) => crew.queries.get(id)
      },
      // The terminator's owned end after a restart: no driver session, the recorded tree kill.
      endSurvivor: (dwarfId) => {
        const process = db.records.live().find((r) => r.dwarfId === dwarfId)?.process
        if (process === undefined) return Promise.resolve({ kind: 'ended' as const })
        return os.killTree(process, { graceMs: 2_000, group: 'owned' })
      },
      catalogue: {
        // Only `resume` and `adopt` are read by the recovery pass (15 §2 effective values).
        capabilities: () =>
          ({ resume: deps.resume ?? 'cli-flag', adopt: true }) as unknown as ProviderCapabilities
      },
      deliveries: {
        reconcileSending: (dwarfIds) => deps.deliveries?.(dwarfIds) ?? Promise.resolve(new Map())
      }
    })
    return { bus, log, resumable, bound, reports, launching, recovery }
  }

  /** Runs the scheduler until nothing is due (each resume answers after `resumeMs`). */
  const drain = async (until = 60_000) => {
    for (let step = 0; step < until; step += 50) {
      await Promise.resolve()
      await Promise.resolve()
      clock.advance(50)
    }
    for (let n = 0; n < 20; n++) await Promise.resolve()
  }

  return { db, clock, scheduler, crew, os, launched, restart, drain }
}

const types = (published: readonly { type: string }[]) => published.map((e) => e.type)

describe('Host crash recovery (F7)', () => {
  it('[US-RES-009.AC01, S4.18, INV-58] after a crash with every session resumable no toast, no report and no walk-out, and each dwarf keeps its id and name', async () => {
    const w = world()
    const first = w.launched(1)
    const second = w.launched(2)
    w.crew.commands.rename(first.dwarfId, 'Gimli the Bold')
    const crewEventsBefore = w.crew.bus.published.length

    const hostB = w.restart()
    const run = hostB.recovery.start()
    await run.classified
    await w.drain()
    const report = await run.settled

    expect(types(hostB.bus.published)).not.toContain('LaunchedSessionCrashed')
    expect(types(hostB.bus.published)).not.toContain('HostRecovered')
    expect(types(w.crew.bus.published.slice(crewEventsBefore))).not.toContain('DwarfDeparted')
    expect(report.unrecovered).toEqual([])
    expect(report.resumed).toEqual([first.dwarfId, second.dwarfId])
    expect(hostB.reports.pending()).toBeNull()
    expect(hostB.bound).toEqual([
      { ref: expect.objectContaining({ providerSessionId: 'session-1' }), dwarfId: first.dwarfId },
      { ref: expect.objectContaining({ providerSessionId: 'session-2' }), dwarfId: second.dwarfId }
    ])
    expect(w.crew.queries.get(first.dwarfId)?.displayName).toBe('Gimli the Bold')
    expect(w.crew.queries.crewOf(MINE).map((d) => d.id)).toEqual([first.dwarfId, second.dwarfId])
    // Each record now names this epoch and the resumed process, so a later crash recovers it again.
    expect(w.db.records.live().map((r) => [r.dwarfId, r.hostEpoch, r.process?.pid])).toEqual([
      [first.dwarfId, EPOCH_B, 9_001],
      [second.dwarfId, EPOCH_B, 9_002]
    ])
    // The old processes' exits are covered by this recovery: no PO #62 toast (TC-173-02).
    expect(
      hostB.launching.commands.sessionExited({
        dwarfId: first.dwarfId,
        pendingEnd: null,
        present: true
      })
    ).toEqual({ owned: true, covered: true, crashed: false })
  })

  it('[US-RES-009.AC02] a crash while no UI ran recovers every resumable session before the first snapshot of the next attach, which shows no notice', async () => {
    const w = world()
    const owned = w.launched(1)
    const hostB = w.restart()

    const run = hostB.recovery.start()
    await run.classified
    // The first snapshot is read after `ready`: the dwarf is already in its mine, nothing is pending.
    expect(w.crew.queries.crewOf(MINE).map((d) => d.id)).toEqual([owned.dwarfId])
    expect(hostB.reports.pending()).toBeNull()
    await w.drain()
    const report = await run.settled
    expect(report.resumed).toEqual([owned.dwarfId])
    expect(hostB.bound.map((b) => b.dwarfId)).toEqual([owned.dwarfId])
    expect(hostB.reports.pending()).toBeNull()
    expect(w.crew.queries.get(owned.dwarfId)?.processState).toBe('running')
  })

  it('[US-RES-009.AC07] a Host respawned by the tray resumes every resumable session without a window', async () => {
    const w = world()
    const owned = w.launched(1)
    // The tray's respawn starts the Host with no window attached: nothing in the pass waits for one.
    const hostB = w.restart()

    const run = hostB.recovery.start()
    await run.classified
    await w.drain()
    const report = await run.settled

    expect(hostB.resumable.calls).toEqual([
      { op: 'resume', at: expect.any(Number), providerSessionId: 'session-1' }
    ])
    expect(report.resumed).toEqual([owned.dwarfId])
    expect(types(hostB.bus.published)).toEqual([])
  })

  it('[ADR-015] resumes start one per 500 ms on the FakeScheduler and classification finishes before ready', async () => {
    const w = world()
    w.launched(1)
    w.launched(2)
    w.launched(3)
    const hostB = w.restart()

    const run = hostB.recovery.start()
    await run.classified
    // Classification is done before any provider is asked to resume.
    expect(hostB.resumable.calls).toEqual([])
    const started = w.clock.now()
    await w.drain()
    await run.settled

    expect(hostB.resumable.calls.map((c) => c.at - started)).toEqual([
      0,
      RESUME_SPACING_MS,
      2 * RESUME_SPACING_MS
    ])
  })

  it('[S16.02, ADR-015] a resume that fails later adds its item and the report is offered only after every initial resume settled', async () => {
    const w = world({ resumeMs: 5_000 })
    const first = w.launched(1)
    const second = w.launched(2)
    const hostB = w.restart()
    hostB.resumable.arrange({ kind: 'rejects', reason: 'stale-ref' })
    hostB.resumable.arrange({ kind: 'same-id' })

    const run = hostB.recovery.start()
    await run.classified
    await w.drain(5_100)
    // The first resume failed, the second is still in flight: nothing is offered yet.
    expect(hostB.reports.pending()).toBeNull()
    expect(types(hostB.bus.published)).not.toContain('HostRecovered')

    await w.drain()
    const report = await run.settled
    expect(report.unrecovered).toEqual([{ dwarfId: first.dwarfId, reason: 'stale-ref' }])
    expect(report.resumed).toEqual([second.dwarfId])
    expect(hostB.bus.published.filter((e) => e.type === 'HostRecovered')).toHaveLength(1)
    expect(hostB.reports.pending()).toEqual(report)
    expect(w.crew.queries.get(first.dwarfId)?.processState).toBe('unrecovered')
    expect(w.crew.queries.crewOf(MINE).map((d) => d.id)).toContain(first.dwarfId)
  })

  it('[FM-016, S7.16] a message still sending with no evidence within 10 s becomes failed host-interrupted and is listed in the report', async () => {
    const w = world()
    const owned = w.launched(1)
    // The conversation module over a template database holding the dwarf's message left `sending`.
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    seedConversationDb(db, runner, T0 as Instant)
    runner.inTransaction(() =>
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at)
         VALUES (?, '00000000-0000-7000-8000-0000000000f1', 'claude', 'session-recovered', 'Durin',
           'foreman', 'running', 'none-yet', ?, ?)`,
        [owned.dwarfId, T0, T0]
      )
    )
    const convIds = new SequenceIdGenerator()
    const messageId = sqliteProbe(db, runner, convIds, T0 as Instant).seedSendingRow(
      owned.dwarfId,
      'Shore up the deep seam'
    )
    const sent = new RecordingEventBus()
    const conversation = createConversation({
      db,
      transactions: runner,
      bus: new RecordingEventBus(),
      lifecycleFacts: { record: () => 'recorded', has: () => false } as never,
      clock: w.clock,
      ids: convIds,
      hostEpoch: EPOCH_B
    })
    const hostB = w.restart({
      deliveries: (dwarfIds) =>
        conversation.reconcileSending({
          dwarfIds,
          windowMs: 10_000,
          scheduler: w.scheduler,
          bus: sent as never
        })
    })

    const run = hostB.recovery.start()
    await run.classified
    await w.drain(9_900)
    expect(types(sent.published)).toEqual([])
    await w.drain()
    const report = await run.settled

    expect(sent.published).toEqual([
      expect.objectContaining({
        type: 'MessageDeliveryFailed',
        payload: { messageId, dwarfId: owned.dwarfId, failure: { kind: 'host-interrupted' } }
      })
    ])
    const [row] = db.all('SELECT phase FROM deliveries WHERE message_id = ?', [messageId])
    expect(row?.['phase']).toBe('failed')
    expect(report.unrecovered).toEqual([
      { dwarfId: owned.dwarfId, reason: 'turn-lost', messageIds: [messageId] }
    ])
    db.close()
  })

  it('[FM-002, CH-01, S4.18] a crash during an active turn on a stdio driver resumes the session and lists it turn-lost for information only, with no toast, and the turn is never replayed', async () => {
    const w = world()
    const owned = w.launched(1, 'working')
    const hostB = w.restart()

    const run = hostB.recovery.start()
    await run.classified
    await w.drain()
    const report = await run.settled

    expect(report.resumed).toEqual([owned.dwarfId])
    expect(report.unrecovered).toEqual([{ dwarfId: owned.dwarfId, reason: 'turn-lost' }])
    expect(types(hostB.bus.published)).toEqual(['HostRecovered'])
    expect(types(hostB.bus.published)).not.toContain('LaunchedSessionCrashed')
    // Informational: the dwarf runs again, it is not marked unrecovered.
    expect(w.crew.queries.get(owned.dwarfId)?.processState).toBe('running')
    // Resumed by its id only: no turn is sent to the resumed session.
    expect(hostB.resumable.calls.map((c) => c.op)).toEqual(['resume'])
  })

  it('[S4.24, FM-110, TC-173-03] after a machine reboot no session is resumed and no report item exists, and the dwarf leaves with no toast', async () => {
    const w = world()
    const owned = w.launched(1)
    const before = w.crew.bus.published.length
    const hostB = w.restart({ previous: { kind: 'rebooted', rule: 'boot-id' } })

    const run = hostB.recovery.start()
    await run.classified
    await w.drain()
    const report = await run.settled

    expect(hostB.resumable.calls).toEqual([])
    expect(report.unrecovered).toEqual([])
    expect(hostB.reports.pending()).toBeNull()
    expect(types(hostB.bus.published)).toEqual([])
    expect(w.db.records.live()).toEqual([])
    expect(w.crew.bus.published.slice(before)).toEqual([
      expect.objectContaining({
        type: 'DwarfDeparted',
        payload: expect.objectContaining({ dwarfId: owned.dwarfId, cause: 'closed-elsewhere' })
      })
    ])
  })

  it('[S4.09, S4.10, S4.11, S4.13, S4.14, S4.15, S4.19] every recovery transition of machine 4A reaches its derived state: a crash orphans the session, a live server-kind session is re-adopted, a survivor ended for recovery resumes or, when its kill fails, is unrecovered end-failed, and a failed boot resume is unrecovered', async () => {
    // S4.09: the crash leaves the record live; nothing ran at crash time.
    const w = world({ adopt: true })
    const server = w.launched(1, 'idle', 'session-server')
    const survivor = w.launched(2)
    const stuck = w.launched(3)
    const failing = w.launched(4)
    expect(w.db.records.live().map((r) => r.dwarfId)).toEqual([
      server.dwarfId,
      survivor.dwarfId,
      stuck.dwarfId,
      failing.dwarfId
    ])
    w.os.scriptTree(server.process)
    w.os.scriptTree(survivor.process)
    w.os.scriptTree(stuck.process, { endsOn: 'never' })
    const hostB = w.restart()
    const answers: ResumeAnswer[] = [
      { kind: 'same-id' }, // S4.10 → S4.11: adopt returns a session
      { kind: 'same-id' }, // S4.14: the survivor's resume after its end
      { kind: 'rejects', reason: 'resume-error' } // S4.19
    ]
    for (const answer of answers) hostB.resumable.arrange(answer)

    const run = hostB.recovery.start()
    await run.classified
    await w.drain()
    const report = await run.settled

    expect(hostB.resumable.calls.map((c) => [c.op, c.providerSessionId])).toEqual([
      ['adopt', 'session-1'],
      ['resume', 'session-2'],
      ['resume', 'session-4']
    ])
    // S4.13: the survivor was ended identity-checked before its resume.
    expect(w.os.signals.some((s) => s.pid === survivor.process.pid)).toBe(true)
    expect(w.os.signals.some((s) => s.pid === server.process.pid)).toBe(false)
    expect(report.resumed).toEqual([server.dwarfId, survivor.dwarfId])
    expect(report.unrecovered).toEqual([
      { dwarfId: stuck.dwarfId, reason: 'end-failed' }, // S4.15
      { dwarfId: failing.dwarfId, reason: 'resume-error' } // S4.19
    ])
    for (const dwarfId of [stuck.dwarfId, failing.dwarfId]) {
      expect(w.crew.queries.get(dwarfId)?.processState).toBe('unrecovered')
    }
  })
})
