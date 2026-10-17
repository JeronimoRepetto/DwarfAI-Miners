// The L2 Host recovery world (17 §1.2, §1.10 CH-01; 11 F7; UC-025; ADR-015 items 3–5, 7) shared by
// wiring/flows/hostRecovery.test.ts (ISSUE-173) and wiring/flows/recoveryReport.test.ts
// (ISSUE-174): the Host stops unexpectedly and a new Host composition starts over the same stored
// rows. Host A's launch is written as the launch use case writes it (testing/launchRecording.ts:
// `launches`, `processes`, `launch_records`) and its dwarf arrives through crew; each restarted Host
// is a new launching module over the same in-memory launching stores, the same recovery report
// rows and the same crew rows (the "database"), the same FakeProcessControl state (the OS), a
// resumable driver double (the provider CLI), FakeClock and FakeScheduler. Its recovery pass runs
// as boot step 5 runs it, and its report routes as host/wiring/routes/launching.ts routes them
// (`routeRecovery`) into a recording frame publisher. No real time, no process, no disk. Never
// imported by production code (R14).
import type { HostFrameData, HostFrameName } from '@dwarfai/contracts'
import type { PreviousEpochEnd } from '../../../kernel/domain/bootIdentity'
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type {
  DwarfId,
  FolderPath,
  HostEpoch,
  LaunchId,
  MineId,
  ProviderId
} from '../../../kernel/domain/values'
import { FakeProcessControl } from '../../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { rankForDepth } from '../../../modules/crew'
import { inMemoryCrew } from '../../../modules/crew/testing/inMemoryCrew'
import {
  createLaunching,
  type Launch,
  type LaunchingEvent,
  type LaunchRecord
} from '../../../modules/launching'
import { InMemoryRecoveryReportStore } from '../../../modules/launching/testing/InMemoryRecoveryReportStore'
import { inMemoryLaunching } from '../../../modules/launching/testing/inMemoryLaunching'
import { launchRecording } from '../../../modules/launching/testing/launchRecording'
import { ResumableDriver } from '../../../modules/launching/testing/ResumableDriver'
import type {
  DriverTransport,
  ProviderCapabilities,
  ProviderDriver,
  SessionRef
} from '../../../modules/suppliers'
import { routeRecovery } from '../../routes/launching'

export const T0 = 1_790_000_000_000
export const EPOCH_A = 'epoch-173-a' as HostEpoch
export const EPOCH_B = 'epoch-173-b' as HostEpoch
export const MINE = '00000000-0000-7000-8000-0000000173f1' as MineId
export const FOLDER = '/work/deep-seam' as FolderPath
export const PROVIDER = 'claude' as ProviderId
const BOOT = 'boot-173'
const CRASHED: PreviousEpochEnd = { kind: 'crashed', rule: 'none' }

export interface Owned {
  dwarfId: DwarfId
  launchId: LaunchId
  process: ProcessIdentity
  record: LaunchRecord
}

/** One frame the routes published, as the connection registry received it. */
export interface PublishedFrame {
  name: HostFrameName
  data: unknown
}

/** The stored rows and the OS a stopped Host leaves behind, and each Host composed over them. */
export function hostRecoveryWorld(
  opts: { adopt?: boolean; resumeMs?: number; transport?: DriverTransport } = {}
) {
  const db = inMemoryLaunching(T0)
  const clock = db.clock
  const scheduler = new FakeScheduler(clock)
  const crew = inMemoryCrew()
  const os = new FakeProcessControl({ bootId: BOOT, clock })
  const recording = launchRecording(db)
  const ids = new SequenceIdGenerator()
  // One transaction flag over the launching stores and the report rows: the same database.
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
  let pid = 7_300
  let nextPid = 9_000

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

  /** A restarted Host over the same rows: launching with its recovery pass, as host/main.ts binds it. */
  const restart = (
    deps: {
      epoch?: HostEpoch
      previous?: PreviousEpochEnd | null
      resume?: 'cli-flag' | 'none'
      deliveries?: (dwarfIds: readonly DwarfId[]) => Promise<Map<DwarfId, string[]>>
      /** Whether a `ui` connection is attached when the routes publish (default: none). */
      ui?: boolean
    } = {}
  ) => {
    const hostEpoch = deps.epoch ?? EPOCH_B
    const bus = new RecordingEventBus<LaunchingEvent>()
    const log = new RecordingDiagnosticsLog()
    const pids = [1, 2, 3, 4].map(() => (nextPid += 1))
    const resumable = new ResumableDriver({
      providerId: PROVIDER,
      ...(opts.transport === undefined ? {} : { transport: opts.transport }),
      clock,
      scheduler,
      resumeMs: opts.resumeMs ?? 50,
      adopt: opts.adopt ?? false,
      pids
    })
    for (const next of pids) os.script(next, { pid: next, processStartTimeMs: T0, bootId: BOOT })
    const bound: Array<{ ref: SessionRef; dwarfId: DwarfId }> = []
    const drivers: ProviderDriver[] = [resumable.driver]
    const launching = createLaunching({
      launches: db.launches,
      processes: db.processes,
      records: db.records,
      transactions,
      starter: {
        start: () => {
          throw new Error('a restarted Host launches nothing')
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
      hostEpoch,
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
    const frames = {
      published: [] as PublishedFrame[],
      ui: deps.ui ?? false,
      publishFrame<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
        frames.published.push({ name, data: structuredClone(data) })
      },
      connections: () => (frames.ui ? [{ role: 'ui' as const }] : [])
    }
    const routed = routeRecovery({
      events: bus,
      recovery,
      crew: { commands: crew.commands },
      frames
    })
    return { bus, log, resumable, bound, reports, launching, recovery, frames, routed }
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

  return { db, clock, scheduler, crew, os, reports, launched, restart, drain }
}
