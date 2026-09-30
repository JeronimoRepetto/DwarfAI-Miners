// The production ProcessControl (16 §3 row `ProcessControl`, ADR-014, ADR-015 item 1): probe,
// sameProcess and a shell-free spawn (ISSUE-018). killTree and currentBootIdentity land with
// ISSUE-019. Only host/platform/process/** imports node:child_process (R17).
//
// Candidates (ISSUE-018): the legacy process probe's per-OS start-time parsing is kept behind the
// per-OS readers (Linux now reads procfs directly instead of spawning `cat`); its
// "null for gone and for unreadable alike" answer is replaced by the port's 'absent' / 'unknown'
// split; the legacy launch runner's spawn is replaced by one plain spawn per SpawnSpec (its
// detached two-hop console handling and argv builders belong to the drivers, EPIC-09).
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import {
  sameProcess,
  type ProbeResult,
  type ProcessIdentity
} from '../../kernel/domain/processIdentity'
import type {
  ProcessProbeAndSpawn,
  SpawnSpec,
  SpawnedProcess
} from '../../kernel/ports/processControl'
import { createDarwinReader } from './probe/darwin'
import { createLinuxReader } from './probe/linux'
import type { OsProcessReader, QueryRunner, ReadOutcome } from './probe/types'
import { createWin32Reader } from './probe/win32'

export type { OsProcessReader, QueryOutcome, QueryRunner, ReadOutcome } from './probe/types'

/** Node's `spawn` as the adapter calls it; injected by tests to see the exact options. */
export type NodeSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

/**
 * The bound on each OS query of a probe. The package names no probe timeout (16 §2.6 lists the
 * boot-identity read of `currentBootIdentity`, 2 000 ms, which stays that method's, ISSUE-019).
 * 5 000 ms is the bound the legacy probe ran with in production (`processProbe.ts`
 * `runProbeCommand`); 2 000 ms left no room for a cold PowerShell start on a CI runner. A query
 * that outlives it reads as no answer, so the probe says `'unknown'` — never the same process.
 */
export const PROBE_QUERY_TIMEOUT_MS = 5_000

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
}

type Liveness = 'alive' | 'gone' | 'unknown'
type ExitOutcome = { code: number | null; signal: string | null }
/** A probe answer and, for `'unknown'`, which read failed and why. */
type Inspection = { result: ProbeResult; cause?: string }

export class NodeProcessControl implements ProcessProbeAndSpawn {
  private readonly reader: OsProcessReader
  private readonly signalZero: (pid: number) => void
  private readonly spawnProcess: NodeSpawn
  /**
   * The boot id never changes while this process lives. Its read starts when the adapter is built
   * (ADR-015 item 4 source), so no probe pays for it; a failed read is retried once per probe.
   */
  private bootRead: Promise<ReadOutcome<string>>

  constructor(options: NodeProcessControlOptions = {}) {
    this.reader = options.reader ?? readerForThisOs()
    this.signalZero = options.signalZero ?? ((pid) => process.kill(pid, 0))
    this.spawnProcess = options.spawnProcess ?? spawn
    this.bootRead = this.readBootId()
  }

  async probe(pid: number): Promise<ProbeResult> {
    return (await this.inspect(pid)).result
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
 */
export function createQueryRunner(timeoutMs: number): QueryRunner {
  return (file, args, env) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        {
          timeout: timeoutMs,
          windowsHide: true,
          shell: false,
          encoding: 'utf8',
          ...(env === undefined ? {} : { env: { ...process.env, ...env } })
        },
        (error, stdout) => {
          if (error === null) resolve({ ok: true, stdout })
          else if (error.killed === true)
            resolve({ ok: false, cause: `timed out after ${timeoutMs} ms` })
          else if (typeof error.code === 'number')
            resolve({ ok: false, cause: `exited with code ${error.code}` })
          else resolve({ ok: false, cause: `could not start (${error.code ?? error.message})` })
        }
      )
    })
}

function readerForThisOs(): OsProcessReader {
  const runQuery = createQueryRunner(PROBE_QUERY_TIMEOUT_MS)
  if (process.platform === 'win32') return createWin32Reader({ runQuery })
  if (process.platform === 'darwin') return createDarwinReader({ runQuery })
  return createLinuxReader()
}
