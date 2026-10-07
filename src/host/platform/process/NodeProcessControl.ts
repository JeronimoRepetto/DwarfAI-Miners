// The production ProcessControl (16 §3 row `ProcessControl`, ADR-014, ADR-015): probe,
// sameProcess and a shell-free spawn (ISSUE-018); the identity-checked tree kill and the boot
// identity (ISSUE-019); the read-only process listing of owner amendment I. Only
// host/platform/process/** imports node:child_process (R17).
//
// Candidates (ISSUE-018): the legacy process probe's per-OS start-time parsing is kept behind the
// per-OS readers (Linux now reads procfs directly instead of spawning `cat`); its
// "null for gone and for unreadable alike" answer is replaced by the port's 'absent' / 'unknown'
// split; the legacy launch runner's spawn is replaced by one plain spawn per SpawnSpec (its
// detached two-hop console handling and argv builders belong to the drivers, EPIC-09).
//
// Candidate (ISSUE-019): the legacy process-end port (`src/main/platform/processEnd.ts`) is
// replaced. Its argv builders (`taskkill /PID <pid> /T /F`, a positive-pid guard before any group
// signal) survive as the per-OS sequences under `kill/`, but it signals a bare pid with no identity
// check, reports success when a command exits 0 instead of when the root's exit is observed, and
// answers `false` for every Windows observed session (the observed-tree gap of 16 §3).
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import {
  sameProcess,
  type ProbeResult,
  type ProcessIdentity
} from '../../kernel/domain/processIdentity'
import type { DiagnosticEntry, DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type {
  EndOutcome,
  ProcessControl,
  SpawnSpec,
  SpawnedProcess
} from '../../kernel/ports/processControl'
import type { Scheduler } from '../../kernel/ports/scheduler'
import { createDarwinBootSources } from './bootIdentity/darwin'
import { createLinuxBootSources } from './bootIdentity/linux'
import { createWin32BootSources } from './bootIdentity/win32'
import { killForeignTree } from './kill/posixForeign'
import { killOwnedTree } from './kill/posixOwned'
import { createSnapshotReader } from './kill/snapshot'
import {
  EXIT_POLL_INTERVAL_MS,
  type KillDeps,
  type ProcessRow,
  type RootCheck,
  type SignalOutcome
} from './kill/types'
import { killWin32Tree, taskkillArgs } from './kill/win32'
import {
  createDarwinListing,
  createLinuxListing,
  createWin32Listing,
  matchedStem,
  type RawListing
} from './list/listing'
import { createDarwinReader } from './probe/darwin'
import { createLinuxReader } from './probe/linux'
import {
  windowsSystemTool,
  type BootSourceReader,
  type OsProcessReader,
  type QueryRunner,
  type ReadOutcome
} from './probe/types'
import { createWin32Reader } from './probe/win32'

export type { OsProcessReader, QueryOutcome, QueryRunner, ReadOutcome } from './probe/types'
export { BOOT_ID_QUERY_TIMEOUT_MS, START_TIME_QUERY_TIMEOUT_MS } from './probe/types'

/** Node's `spawn` as the adapter calls it; injected by tests to see the exact options. */
export type NodeSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

/**
 * Environment names the OS or its runtime puts into a child whatever the spec says; the contract
 * allows exactly these beyond the spec (06 INV-59 still holds: none carries a DwarfAI token).
 * - win32: libuv copies these from the parent into every child environment that lacks them
 *   (`required_vars` in libuv `src/win/process.c`); Windows programs need them to start.
 * - darwin: CoreFoundation sets `__CF_USER_TEXT_ENCODING` in the child's own environment when it
 *   loads and finds it missing (Apple CF `CFStringEncodings.c` `_CFStringGetUserDefaultEncoding`
 *   calls `setenv(__kCFUserEncodingEnvVariableName, …)`; `CFStringDefaultEncoding.h` defines that
 *   name as "__CF_USER_TEXT_ENCODING"). It is the user's text encoding, not inherited data.
 * - linux: nothing.
 */
export const OS_ADDED_ENV: Readonly<Record<'win32' | 'darwin' | 'linux', readonly string[]>> = {
  win32: [
    'HOMEDRIVE',
    'HOMEPATH',
    'LOGONSERVER',
    'PATH',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR'
  ],
  darwin: ['__CF_USER_TEXT_ENCODING'],
  linux: []
}

export interface NodeProcessControlOptions {
  /** The per-OS start-time and boot-id reader; default the reader of this OS. */
  reader?: OsProcessReader
  /** `process.kill(pid, 0)`: throws ESRCH when no process has the pid. Injected by tests. */
  signalZero?: (pid: number) => void
  /** Node's `spawn`; injected by tests. */
  spawnProcess?: NodeSpawn
  /** Which OS's kill sequence, listing and boot sources to use; default this process's OS. */
  platform?: 'win32' | 'darwin' | 'linux'
  /** `process.kill(pid, signal)`; a negative pid names a process group. Injected by tests. */
  sendSignal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** Runs the kill commands (taskkill on Windows); default the bounded execFile runner. */
  runCommand?: QueryRunner
  /** A listing of every process; default the listing of `platform`. */
  snapshot?: () => Promise<ReadOutcome<readonly ProcessRow[]>>
  /** The processes carrying a stem, with their working folders (owner amendment I); default `platform`'s. */
  listing?: RawListing
  /** The kill waits run on it (16 §2.6); default Node timers. */
  scheduler?: Scheduler
  /** The bootTimeMs and logonSessionId sources; default those of `platform` (ADR-015 item 4). */
  bootSources?: BootSourceReader
  /** Where read failures and kill leftovers are logged (ADR-026); default nowhere. */
  diagnostics?: DiagnosticsLog
  /** The environment System32 tools are found from (`SystemRoot`); default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
}

type Liveness = 'alive' | 'gone' | 'unknown'
type Platform = 'win32' | 'darwin' | 'linux'
type BootIdentity = {
  bootId: string | 'unknown'
  bootTimeMs: number | 'unknown'
  logonSessionId: string | 'unknown'
}

/**
 * The bound on one taskkill. The package names none; 5 000 ms is what the legacy kill runner gave
 * each kill command (`processEnd.ts` `runEndCommand`).
 */
export const KILL_COMMAND_TIMEOUT_MS = 5_000
type ExitOutcome = { code: number | null; signal: string | null }
/** A probe answer and, for `'unknown'`, which read failed and why. */
type Inspection = { result: ProbeResult; cause?: string }

export class NodeProcessControl implements ProcessControl {
  private readonly reader: OsProcessReader
  private readonly signalZero: (pid: number) => void
  private readonly spawnProcess: NodeSpawn
  private readonly sendSignal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  private readonly platform: Platform
  private readonly runCommand: QueryRunner
  private readonly listSnapshot: () => Promise<ReadOutcome<readonly ProcessRow[]>>
  private readonly listing: RawListing
  private readonly scheduler: Scheduler
  private readonly bootSources: BootSourceReader
  private readonly diagnostics: DiagnosticsLog
  private readonly env: Readonly<Record<string, string | undefined>>
  /**
   * The boot id never changes while this process lives. Its read starts when the adapter is built
   * (ADR-015 item 4 source, bounded by BOOT_ID_QUERY_TIMEOUT_MS), so no probe pays for it: a probe
   * that finds it in flight awaits that same read; a failed read is retried once per later probe.
   */
  private bootRead: Promise<ReadOutcome<string>>

  constructor(options: NodeProcessControlOptions = {}) {
    this.platform = options.platform ?? thisPlatform()
    this.runCommand = options.runCommand ?? createQueryRunner()
    this.env = options.env ?? process.env
    this.reader = options.reader ?? readerFor(this.platform, this.runCommand, this.env)
    this.signalZero = options.signalZero ?? ((pid) => process.kill(pid, 0))
    this.spawnProcess = options.spawnProcess ?? spawn
    this.sendSignal = options.sendSignal ?? ((pid, signal) => process.kill(pid, signal))
    this.listSnapshot =
      options.snapshot ??
      createSnapshotReader(this.platform, { runQuery: this.runCommand, env: this.env })
    this.listing = options.listing ?? listingFor(this.platform, this.runCommand, this.env)
    this.scheduler = options.scheduler ?? NODE_SCHEDULER
    this.bootSources =
      options.bootSources ?? bootSourcesFor(this.platform, this.runCommand, this.env)
    this.diagnostics = options.diagnostics ?? { record: () => {} }
    this.bootRead = this.readBootId()
  }

  async probe(pid: number): Promise<ProbeResult> {
    return (await this.inspect(pid)).result
  }

  /**
   * 16 §3 `isRunning` (owner amendment H, 2026-10-07): signal 0 only, the same liveness read that
   * opens every probe, so it never spawns and never reads a start time. Never evidence of identity
   * (INV-51); pid 0 and negative pids name process groups, never one process.
   */
  isRunning(pid: number): 'running' | 'absent' | 'unknown' {
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'absent'
    const liveness = this.liveness(pid)
    return liveness === 'alive' ? 'running' : liveness === 'gone' ? 'absent' : 'unknown'
  }

  /**
   * 16 §3 `listProcesses` (owner amendment I, 2026-10-07): this OS's listing (`list/listing.ts`),
   * each match named by the wanted stem it carries. Read only, no pid: never evidence of identity
   * (INV-51). An unreadable listing is `'unreadable'` and logged by its cause code only (ADR-026: a
   * cause may name a path), never an empty list.
   */
  async listProcesses(filter: {
    stems: readonly string[]
  }): Promise<ReadonlyArray<{ stem: string; cwd: string | null }> | 'unreadable'> {
    if (filter.stems.length === 0) return []
    const listed = await settle(() => this.listing(filter.stems))
    if (!listed.ok) {
      this.record({
        level: 'warn',
        event: 'process.listing.unreadable',
        subsystem: 'kernel',
        outcome: 'degraded',
        ...errCodeOf(listed.cause)
      })
      return 'unreadable'
    }
    const rows: Array<{ stem: string; cwd: string | null }> = []
    for (const process of listed.value) {
      const stem = matchedStem(process, filter.stems)
      if (stem !== null) rows.push({ stem, cwd: process.cwd })
    }
    return rows
  }

  sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
    return sameProcess(a, b)
  }

  spawn(spec: SpawnSpec): SpawnedProcess {
    // shell: false and windowsHide: true are fixed here and never taken from the spec (ADR-029;
    // AMENDMENT-10); the environment is exactly the spec's copy, nothing inherited (06 INV-59).
    let child: ChildProcess
    try {
      child = this.spawnProcess(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        env: { ...spec.env },
        shell: false,
        windowsHide: true,
        detached: spec.processGroup === 'own',
        stdio: spec.stdio
      })
    } catch (error) {
      // Node refuses some specs synchronously (for example EINVAL for a .cmd on Windows): the
      // caller sees the same rejected pair as for a spawn that fails to start.
      return notStarted(error)
    }
    const started = new Promise<number>((resolve, reject) => {
      child.once('spawn', () => resolve(child.pid as number))
      child.once('error', (error) => {
        if (child.pid === undefined) reject(error)
      })
    })
    const exited = new Promise<ExitOutcome>((resolve, reject) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
      started.catch(reject)
    })
    const identity = started.then(async (pid) => {
      const { result, cause } = await this.inspect(pid)
      if (typeof result === 'string') {
        const why = cause === undefined ? '' : ` (${cause})`
        throw new Error(`the identity of spawned pid ${pid} could not be read: ${result}${why}`)
      }
      return result
    })
    // A caller that never awaits one of them must not see an unhandled rejection.
    identity.catch(() => {})
    exited.catch(() => {})
    return { identity, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited }
  }

  /**
   * ADR-014 items 2–4: the root's identity is re-verified before the first signal and before every
   * escalation (mismatch or absent = `ended`, unreadable = `no-identity`, nothing signalled); the
   * tree is ended per OS (`kill/`); `ended` only once the root's exit is observed.
   */
  killTree(
    target: ProcessIdentity,
    opts: { graceMs: number; group: 'owned' | 'foreign' }
  ): Promise<EndOutcome> {
    const deps: KillDeps = {
      target,
      graceMs: opts.graceMs,
      checkRoot: () => this.checkRoot(target),
      snapshot: () => this.snapshot(),
      waitForExit: (pid, ms) => this.waitForExit(pid, ms),
      reportSurvivors: (count) =>
        this.record({ level: 'warn', event: 'terminate.leftover', subsystem: 'kernel', count })
    }
    if (this.platform === 'win32') {
      return killWin32Tree({ ...deps, taskkill: (pid, tree) => this.taskkill(pid, tree) })
    }
    const posix = {
      ...deps,
      signal: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => this.signal(pid, sig)
    }
    return opts.group === 'owned' ? killOwnedTree(posix) : killForeignTree(posix)
  }

  /**
   * 16 §3 (AMENDMENT-3): the boot id from the same read the probes use (one derivation, one bound),
   * the boot instant and the Host's logon session from the ADR-015 item 4 sources of this OS. Each
   * unreadable field is `'unknown'` and logged; it never rejects.
   */
  async currentBootIdentity(): Promise<BootIdentity> {
    // Three independent reads in parallel: a slow boot-instant query delays nothing else and makes
    // only its own field 'unknown' (it is never on the probe path).
    const [bootId, bootTime, logon] = await Promise.all([
      this.currentBootId(),
      settle(() => this.bootSources.bootTimeMs()),
      settle(() => this.bootSources.logonSessionId())
    ])
    return {
      bootId: this.knownOrUnknown('bootId', bootId, (value) => value !== ''),
      bootTimeMs: this.knownOrUnknown('bootTimeMs', bootTime, Number.isFinite),
      logonSessionId: this.knownOrUnknown('logonSessionId', logon, (value) => value !== '')
    }
  }

  private knownOrUnknown<T extends string | number>(
    field: keyof BootIdentity,
    read: ReadOutcome<T>,
    valid: (value: T) => boolean
  ): T | 'unknown' {
    if (read.ok && valid(read.value) && read.value !== 'unknown') return read.value
    const cause = read.ok ? 'gave an unusable answer' : read.cause
    this.record({
      level: 'warn',
      event: 'process.boot-identity.unknown',
      subsystem: 'kernel',
      outcome: 'degraded',
      causeClass: field,
      ...errCodeOf(cause)
    })
    return 'unknown'
  }

  private async checkRoot(target: ProcessIdentity): Promise<RootCheck> {
    const { result } = await this.inspect(target.pid)
    if (result === 'absent') return 'gone'
    if (result === 'unknown') return 'unknown'
    return sameProcess(result, target) ? 'match' : 'gone'
  }

  private async snapshot(): Promise<readonly ProcessRow[] | null> {
    const listed = await this.listSnapshot().catch(readFailed)
    if (listed.ok) return listed.value
    this.record({
      level: 'warn',
      event: 'process.snapshot.unreadable',
      subsystem: 'kernel',
      outcome: 'degraded',
      ...errCodeOf(listed.cause)
    })
    return null
  }

  /** Polls the pid's liveness every EXIT_POLL_INTERVAL_MS on the scheduler until gone or `ms`. */
  private async waitForExit(pid: number, ms: number): Promise<boolean> {
    let waited = 0
    for (;;) {
      if (this.liveness(pid) === 'gone') return true
      if (waited >= ms) return false
      const step = Math.min(EXIT_POLL_INTERVAL_MS, ms - waited)
      await new Promise<void>((resolve) => this.scheduler.after(step, resolve))
      waited += step
    }
  }

  /**
   * One POSIX signal. Never pid 0 or -1 (the caller's own group, every process the user owns): the
   * sequences only ever pass a verified positive pid or its negation.
   */
  private signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): SignalOutcome {
    if (!Number.isSafeInteger(pid) || pid === 0 || pid === -1) return 'failed'
    try {
      this.sendSignal(pid, signal)
      return 'delivered'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return 'absent'
      return code === 'EPERM' ? 'denied' : 'failed'
    }
  }

  /**
   * One taskkill from System32 by absolute path. Exit 128 is "no such process". Any other failure
   * is `denied` when the process refuses even a liveness check (libuv opens it with terminate
   * rights for that, so EPERM means this user may not end it), otherwise `failed`.
   */
  private async taskkill(pid: number, tree: boolean): Promise<SignalOutcome> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'failed'
    const out = await this.runCommand(
      windowsSystemTool('taskkill.exe', this.env),
      taskkillArgs(pid, tree),
      { timeoutMs: KILL_COMMAND_TIMEOUT_MS }
    )
    if (out.ok) return 'delivered'
    if (out.cause === 'exited with code 128') return 'absent'
    try {
      this.signalZero(pid)
      return 'failed'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return 'absent'
      return code === 'EPERM' ? 'denied' : 'failed'
    }
  }

  private record(entry: DiagnosticEntry): void {
    try {
      this.diagnostics.record(entry)
    } catch {
      // DiagnosticsLog never throws into the caller (16 §3); a faulty double must not either.
    }
  }

  private async inspect(pid: number): Promise<Inspection> {
    // pid 0 and negative pids name process groups for kill(); they are never one process.
    if (!Number.isSafeInteger(pid) || pid <= 0) return { result: 'absent' }
    const before = this.liveness(pid)
    if (before === 'gone') return { result: 'absent' }
    if (before === 'unknown') return { result: 'unknown', cause: 'liveness check failed' }
    const [startTime, bootId] = await Promise.all([
      this.reader.startTimeMs(pid).catch(readFailed),
      this.currentBootId()
    ])
    if (!startTime.ok || !Number.isFinite(startTime.value)) {
      // The process may have ended between the two reads; otherwise there is no evidence.
      if (this.liveness(pid) === 'gone') return { result: 'absent' }
      const cause = startTime.ok ? 'gave an unparseable answer' : startTime.cause
      return { result: 'unknown', cause: `start-time read ${cause}` }
    }
    if (!bootId.ok) return { result: 'unknown', cause: `boot-id read ${bootId.cause}` }
    return { result: { pid, processStartTimeMs: startTime.value, bootId: bootId.value } }
  }

  private liveness(pid: number): Liveness {
    try {
      this.signalZero(pid)
      return 'alive'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return 'gone'
      // EPERM: the process exists but belongs to someone else; still a live pid.
      return code === 'EPERM' ? 'alive' : 'unknown'
    }
  }

  /** The boot id read started at construction; one fresh read when that (or the last) failed. */
  private async currentBootId(): Promise<ReadOutcome<string>> {
    const pending = this.bootRead
    const read = await pending
    if (read.ok) return read
    if (this.bootRead === pending) this.bootRead = this.readBootId()
    return this.bootRead
  }

  private readBootId(): Promise<ReadOutcome<string>> {
    return this.reader
      .bootId()
      .then((read): ReadOutcome<string> => (read.ok && read.value === '' ? EMPTY_BOOT_ID : read))
      .catch(readFailed)
  }
}

const EMPTY_BOOT_ID = { ok: false, cause: 'gave an empty answer' } as const

/** Node timers, for the kill waits; a pending wait never keeps the Host alive. */
const NODE_SCHEDULER: Scheduler = {
  after(ms, task) {
    const timer = setTimeout(task, ms)
    timer.unref()
    return { cancel: () => clearTimeout(timer) }
  }
}

/** Runs one read that may throw or reject, as a ReadOutcome. */
function settle<T>(read: () => Promise<ReadOutcome<T>>): Promise<ReadOutcome<T>> {
  try {
    return read().catch(readFailed)
  } catch (error) {
    return Promise.resolve(readFailed(error))
  }
}

/**
 * The errno-like code of a read-failure cause, for the log's `errCode` (ADR-026: never the free
 * text, which may name a path): "timed out" is ETIMEDOUT, "(ENOENT)" is ENOENT, an exit code is
 * that number.
 */
function errCodeOf(cause: string): { errCode?: string } {
  if (cause.startsWith('timed out')) return { errCode: 'ETIMEDOUT' }
  const errno = /\(([A-Z][A-Z0-9_]+)\)/.exec(cause)
  if (errno !== null) return { errCode: errno[1] as string }
  const exit = /exited with code (\d+)/.exec(cause)
  return exit === null ? {} : { errCode: exit[1] as string }
}

function readFailed(error: unknown): ReadOutcome<never> {
  return { ok: false, cause: `failed (${error instanceof Error ? error.message : String(error)})` }
}

function notStarted(error: unknown): SpawnedProcess {
  const failed = Promise.reject(error instanceof Error ? error : new Error(String(error)))
  failed.catch(() => {})
  return { identity: failed, stdin: null, stdout: null, stderr: null, exited: failed }
}

/**
 * One bounded OS query per call: argv array, no shell, killed at `timeoutMs`. Resolves the stdout
 * of a zero exit, or why there is none: "timed out after <ms> ms", "exited with code <n>",
 * "could not start (<errno>)".
 *
 * The bound is a task on `scheduler` (Node timers by default), never execFile's own timer, so a
 * test drives it on a FakeScheduler instead of racing a real process against real time.
 */
export function createQueryRunner(options: { scheduler?: Scheduler } = {}): QueryRunner {
  const scheduler = options.scheduler ?? NODE_SCHEDULER
  return (file, args, { timeoutMs, env, dropEnv }) =>
    new Promise((resolve) => {
      let timedOut = false
      const child = execFile(
        file,
        [...args],
        {
          windowsHide: true,
          shell: false,
          encoding: 'utf8',
          ...(env === undefined && dropEnv === undefined
            ? {}
            : { env: childEnvironment(env ?? {}, dropEnv ?? []) })
        },
        (error, stdout) => {
          bound.cancel()
          if (error === null) resolve({ ok: true, stdout })
          else if (timedOut) resolve({ ok: false, cause: `timed out after ${timeoutMs} ms` })
          else if (typeof error.code === 'number')
            resolve({ ok: false, cause: `exited with code ${error.code}` })
          else resolve({ ok: false, cause: `could not start (${error.code ?? error.message})` })
        }
      )
      // execFile reports even a failed start asynchronously, so the bound is set before any answer.
      const bound = scheduler.after(timeoutMs, () => {
        timedOut = true
        child.kill()
      })
    })
}

/**
 * This process's environment plus `extra`, without the names in `dropped`. Names are compared
 * ignoring case, as Windows compares them, so a `PSModulePath` spelled any way is left out.
 */
function childEnvironment(
  extra: Readonly<Record<string, string>>,
  dropped: readonly string[]
): Record<string, string | undefined> {
  const drop = new Set(dropped.map((name) => name.toUpperCase()))
  const env: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!drop.has(name.toUpperCase())) env[name] = value
  }
  return { ...env, ...extra }
}

function thisPlatform(): Platform {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
}

function readerFor(
  platform: Platform,
  runQuery: QueryRunner,
  env: Readonly<Record<string, string | undefined>>
): OsProcessReader {
  if (platform === 'win32') return createWin32Reader({ runQuery, env })
  if (platform === 'darwin') return createDarwinReader({ runQuery })
  return createLinuxReader()
}

function listingFor(
  platform: Platform,
  runQuery: QueryRunner,
  env: Readonly<Record<string, string | undefined>>
): RawListing {
  if (platform === 'win32') return createWin32Listing({ runQuery, env })
  if (platform === 'darwin') return createDarwinListing({ runQuery })
  return createLinuxListing({
    readText: (path) => readFile(path, 'utf8'),
    listDir: (path) => readdir(path),
    readLink: (path) => readlink(path)
  })
}

function bootSourcesFor(
  platform: Platform,
  runQuery: QueryRunner,
  env: Readonly<Record<string, string | undefined>>
): BootSourceReader {
  if (platform === 'win32') return createWin32BootSources({ runQuery, env })
  if (platform === 'darwin') return createDarwinBootSources({ runQuery })
  return createLinuxBootSources()
}
