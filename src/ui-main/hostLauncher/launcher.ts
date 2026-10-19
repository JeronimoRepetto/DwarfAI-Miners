// The Host launcher (ADR-002 D3, D4, D6; 07 S12.01–S12.03; 13 FM-008…FM-012, FM-114): the one
// audited place in UI main that starts the Host. ADR-002 D4:
//
// 1. Connect to the endpoint and send `hello`. A Host past its boot → `attached`. A Host that
//    holds the endpoint but is still starting or migrating (or refuses a hello it is not ready
//    for) is waited for with the readiness rule, never spawned again.
// 2. Otherwise take the spawn gate, make or reuse the versioned copy and collect the old ones
//    (ADR-002 D5, ADR-027 item 2: versionedCopy.ts, versionedCopyGc.ts), spawn the Host detached
//    from that copy (spawnHost.ts; posix.ts, windows.ts), wait for readiness (readiness.ts) and
//    release the gate — on `hello.ok` or on failure. A copy that cannot be made is `spawn-failed`
//    with its code (FM-129), and nothing is spawned.
// 3. The loser of the gate polls the endpoint every 250 ms and attaches when a Host answers; once
//    the gate is released or stale it takes it and spawns. Once something holds the endpoint
//    without being ready, the readiness budget (15 s, +30 s while `migrating`) bounds the wait.
//
// Results: `spawned` (this UI started the Host that answered), `attached`, or
// `{ unavailable }` with the 12B reason: `elevated-refused` (the Host exited ELEVATED_REFUSED),
// `in-job` (Windows: the Host could not be started outside the UI's job), `spawn-failed` (any
// other failure, including no ready `hello` within 15 s, +30 s while `migrating`).
// A Host that answers with `jobStatus: 'in-job'` is still spawned or attached: the degraded state
// travels in its `hello.ok` (UC-002 alternate flow) and HostClient surfaces it (later: ISSUE-051).
//
// Every spawn outcome is logged as `host.spawn` (19 §9.1): outcome, cause class, error code and
// duration, never a pid or a path.
import type { UiLog, UiLogEntry } from '../diagnostics/uiLogger'
import { HOST_EXIT_CODES } from './hostExitCodes'
import type {
  HelloAnswer,
  HelloProber,
  HostCopyPreparer,
  HostSpawner,
  LauncherClock,
  Sleep
} from './ports'
import {
  LOSER_POLL_MS,
  isReadyState,
  readinessExpired,
  waitForReadiness,
  type ReadinessOutcome
} from './readiness'
import { buildHostSpawn, hostSpawnInputFromCopy, type HostSpawnInput } from './spawnHost'

export type EnsureHostResult =
  'attached' | 'spawned' | { unavailable: 'spawn-failed' | 'elevated-refused' | 'in-job' }

export interface HostLauncherDeps {
  probe: HelloProber
  gate: { take(): Promise<'taken' | 'held'>; release(): Promise<void> }
  spawner: HostSpawner
  /** The versioned copy the Host starts from (ADR-002 D5). */
  prepareCopy: HostCopyPreparer
  /** The Host as the running app holds it; started from its copy, never from here. */
  host: HostSpawnInput
  clock: LauncherClock
  sleep: Sleep
  log: UiLog
}

export interface HostLauncher {
  ensureHostRunning(): Promise<EnsureHostResult>
}

const SUBSYSTEM = 'host-launcher'
const EVENT = 'host.spawn'

export function createHostLauncher(deps: HostLauncherDeps): HostLauncher {
  const record = (entry: Omit<UiLogEntry, 'event' | 'subsystem'>): void =>
    deps.log.record({ ...entry, event: EVENT, subsystem: SUBSYSTEM })

  const fail = (
    reason: 'spawn-failed' | 'elevated-refused' | 'in-job',
    errCode: string,
    durationMs?: number
  ): EnsureHostResult => {
    record({
      level: 'error',
      outcome: 'failed',
      causeClass: reason,
      errCode,
      ...(durationMs === undefined ? {} : { durationMs })
    })
    return { unavailable: reason }
  }

  /** Step 1: a Host that holds the endpoint and is not ready yet is waited for. */
  const awaitBootingHost = async (): Promise<EnsureHostResult> => {
    const startedAt = deps.clock.now()
    const ready = await waitForReadiness(deps)
    if (ready.kind === 'ready') return 'attached'
    return fail('spawn-failed', 'READINESS_TIMEOUT', deps.clock.now() - startedAt)
  }

  /** Step 2, with the gate held. */
  const spawnAndWait = async (): Promise<EnsureHostResult> => {
    const startedAt = deps.clock.now()
    // The Host never runs from the install folder: its copy is made or reused first (ADR-002 D5).
    const copy = await deps.prepareCopy()
    if (!copy.ok) return fail('spawn-failed', copy.errCode)
    const host = hostSpawnInputFromCopy(deps.host, copy)
    if (!host.ok) return fail('spawn-failed', host.errCode)
    const launch = await deps.spawner(buildHostSpawn(host.value))
    if (launch.kind === 'failed') return fail('spawn-failed', launch.errCode)
    if (launch.kind === 'in-job') return fail('in-job', launch.errCode)
    const launched = launch.host
    const watch = { alreadyRunning: false }
    void launched.exited.then((code) => {
      if (code === HOST_EXIT_CODES.ALREADY_RUNNING) watch.alreadyRunning = true
    })
    let ready: ReadinessOutcome
    try {
      ready = await waitForReadiness({ ...deps, exited: launched.exited })
    } finally {
      launched.release()
    }
    const durationMs = deps.clock.now() - startedAt
    if (ready.kind === 'host-exited') {
      return ready.code === HOST_EXIT_CODES.ELEVATED_REFUSED
        ? fail('elevated-refused', 'ELEVATED_REFUSED', durationMs)
        : fail('spawn-failed', `HOST_EXIT_${ready.code}`, durationMs)
    }
    if (ready.kind === 'timed-out') return fail('spawn-failed', 'READINESS_TIMEOUT', durationMs)
    if (watch.alreadyRunning) return 'attached'
    const inJob = ready.answer.jobStatus === 'in-job'
    record({
      level: inJob ? 'warn' : 'info',
      outcome: inJob ? 'degraded' : 'ok',
      causeClass: inJob ? 'in-job' : launched.how,
      // A launch that left every job and still reports one says how it was launched (FM-012 diagnosis).
      ...(inJob ? { errCode: `LAUNCHED_${launched.how.toUpperCase()}` } : {}),
      durationMs
    })
    return 'spawned'
  }

  /**
   * Step 3: a live UI holds the gate. While nothing listens, wait for its Host or for the gate to be
   * released or go stale; once something holds the endpoint, the readiness rule bounds the wait.
   */
  const waitAsLoser = async (): Promise<EnsureHostResult | 'gate-free'> => {
    let heldSince: number | null = null
    for (;;) {
      await deps.sleep(LOSER_POLL_MS)
      const answer = await deps.probe()
      if (isReadyHello(answer)) return 'attached'
      if (answer.kind === 'unreachable') {
        heldSince = null
        if ((await deps.gate.take()) === 'taken') return 'gate-free'
        continue
      }
      heldSince ??= deps.clock.now()
      const waitedMs = deps.clock.now() - heldSince
      if (readinessExpired(waitedMs, answer)) {
        return fail('spawn-failed', 'READINESS_TIMEOUT', waitedMs)
      }
    }
  }

  const ensure = async (): Promise<EnsureHostResult> => {
    const first = await deps.probe()
    if (isReadyHello(first)) return 'attached'
    if (first.kind !== 'unreachable') return awaitBootingHost()
    if ((await deps.gate.take()) === 'held') {
      record({ level: 'info', outcome: 'skipped', causeClass: 'gate-held' })
      const waited = await waitAsLoser()
      if (waited !== 'gate-free') return waited
    }
    try {
      return await spawnAndWait()
    } finally {
      await deps.gate.release()
    }
  }

  return {
    async ensureHostRunning() {
      try {
        return await ensure()
      } catch (error) {
        // An unreadable run folder or gate, a probe that throws: the Host cannot be started from here.
        return fail('spawn-failed', errorCode(error))
      }
    }
  }
}

function isReadyHello(answer: HelloAnswer): boolean {
  return answer.kind === 'hello-ok' && isReadyState(answer.state)
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : 'LAUNCHER_ERROR'
}
