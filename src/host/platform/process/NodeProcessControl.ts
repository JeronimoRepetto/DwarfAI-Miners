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
import type { OsProcessReader, QueryRunner } from './probe/types'
import { createWin32Reader } from './probe/win32'

export type { OsProcessReader, QueryRunner } from './probe/types'

/** Node's `spawn` as the adapter calls it; injected by tests to see the exact options. */
export type NodeSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

/**
 * The bound on every OS query of a probe: the 16 §2.6 boot-identity read timeout, 2 000 ms, the
 * one per-OS-query timeout the package names. A timed-out query reads as no answer ('unknown').
 */
export const PROBE_QUERY_TIMEOUT_MS = 2_000

/**
 * The variables libuv copies from the parent into every Windows child environment that lacks them
 * (`required_vars` of libuv `src/win/process.c`), whatever the spec says. Windows programs need
 * them to start; none carries a DwarfAI token or secret (06 INV-59). Other OSes add nothing.
 */
export const WIN32_REQUIRED_ENV: readonly string[] = [
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
]

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

export class NodeProcessControl implements ProcessProbeAndSpawn {
  private readonly reader: OsProcessReader
  private readonly signalZero: (pid: number) => void
  private readonly spawnProcess: NodeSpawn
  /** The boot id never changes while this process lives; a failed read is retried next time. */
  private bootId: string | null = null

  constructor(options: NodeProcessControlOptions = {}) {
    this.reader = options.reader ?? readerForThisOs()
    this.signalZero = options.signalZero ?? ((pid) => process.kill(pid, 0))
    this.spawnProcess = options.spawnProcess ?? spawn
  }

  async probe(pid: number): Promise<ProbeResult> {
    // pid 0 and negative pids name process groups for kill(); they are never one process.
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'absent'
    const before = this.liveness(pid)
    if (before !== 'alive') return before === 'gone' ? 'absent' : 'unknown'
    const [startTimeMs, bootId] = await Promise.all([
      this.reader.startTimeMs(pid).catch(() => null),
      this.readBootId()
    ])
    if (startTimeMs === null || !Number.isFinite(startTimeMs)) {
      // The process may have ended between the two reads; otherwise there is no evidence.
      return this.liveness(pid) === 'gone' ? 'absent' : 'unknown'
    }
    if (bootId === null) return 'unknown'
    return { pid, processStartTimeMs: startTimeMs, bootId }
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
      const probed = await this.probe(pid)
      if (typeof probed === 'string') {
        throw new Error(`the identity of spawned pid ${pid} could not be read: ${probed}`)
      }
      return probed
    })
    // A caller that never awaits one of them must not see an unhandled rejection.
    identity.catch(() => {})
    exited.catch(() => {})
    return { identity, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited }
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

  private async readBootId(): Promise<string | null> {
    if (this.bootId !== null) return this.bootId
    const read = await this.reader.bootId().catch(() => null)
    if (read !== null && read !== '') this.bootId = read
    return this.bootId
  }
}

function notStarted(error: unknown): SpawnedProcess {
  const failed = Promise.reject(error instanceof Error ? error : new Error(String(error)))
  failed.catch(() => {})
  return { identity: failed, stdin: null, stdout: null, stderr: null, exited: failed }
}

/** One bounded OS query, argv array, no shell; stdout on a zero exit, else null. */
const runQuery: QueryRunner = (file, args, env) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: PROBE_QUERY_TIMEOUT_MS,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        ...(env === undefined ? {} : { env: { ...process.env, ...env } })
      },
      (error, stdout) => resolve(error === null ? stdout : null)
    )
  })

function readerForThisOs(): OsProcessReader {
  if (process.platform === 'win32') return createWin32Reader({ runQuery })
  if (process.platform === 'darwin') return createDarwinReader({ runQuery })
  return createLinuxReader()
}
