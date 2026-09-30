// A scripted operating system for the L3 run of NodeProcessControl (17 §1.3): the adapter's OS
// primitives (liveness, start-time and boot-id reads, signals, taskkill, the process listing, the
// scheduler, the boot sources) answered from an in-memory process table, so the real kill sequences
// run without a real process and without real time. Test code only (R14: `/testing/`).
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { SentSignal } from '../../../kernel/testing/processControl.contract'
import type { ProcessRow } from '../kill/types'
import type {
  BootSourceReader,
  OsProcessReader,
  QueryOutcome,
  QueryRunner,
  ReadOutcome
} from '../probe/types'

export type ScriptedPlatform = 'win32' | 'darwin' | 'linux'

export interface ScriptedProcess {
  pid: number
  ppid: number
  /** POSIX process group; default the pid of the process itself (a group leader). */
  pgid?: number
  startTimeMs: number
  /** The first signal that ends it; default `'term'`. */
  endsOn?: 'term' | 'kill' | 'never'
  /** Every signal to it is refused (EPERM), as for another user's or an elevated process. */
  denied?: boolean
  /** `false`: its start time cannot be read. Default `true`. */
  readable?: boolean
}

type Entry = Required<Omit<ScriptedProcess, 'readable'>> & { readable: boolean; alive: boolean }

export const SCRIPTED_BOOT = '6f1c2d0e-1b2a-4c3d-9e8f-0a1b2c3d4e5f'

const errno = (code: string): Error => Object.assign(new Error(code), { code })

export class ScriptedOs {
  /** Every signal or taskkill the adapter sent, in order, allowed or not. */
  readonly sent: SentSignal[] = []
  /** Every delay the adapter asked the scheduler for, in order. */
  readonly waits: number[] = []
  /** Every taskkill argv, in order (win32). */
  readonly taskkills: Array<{ file: string; args: readonly string[] }> = []
  /** Called after each delivered signal; a test may change the table here (a pid reused, …). */
  onSignal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void = () => {}
  private readonly table = new Map<number, Entry>()

  constructor(readonly platform: ScriptedPlatform = 'linux') {}

  add(process: ScriptedProcess): void {
    this.table.set(process.pid, {
      pid: process.pid,
      ppid: process.ppid,
      pgid: process.pgid ?? process.pid,
      startTimeMs: process.startTimeMs,
      endsOn: process.endsOn ?? 'term',
      denied: process.denied ?? false,
      readable: process.readable ?? true,
      alive: true
    })
  }

  /** Ends `pid` the way the process would end on its own. */
  end(pid: number): void {
    const entry = this.table.get(pid)
    if (entry !== undefined) entry.alive = false
  }

  isRunning(pid: number): boolean {
    return this.table.get(pid)?.alive === true
  }

  readonly reader: OsProcessReader = {
    startTimeMs: (pid) => {
      const entry = this.live(pid)
      return Promise.resolve(
        entry?.readable === true
          ? { ok: true, value: entry.startTimeMs }
          : { ok: false, cause: 'failed for the test' }
      )
    },
    bootId: () => Promise.resolve({ ok: true, value: SCRIPTED_BOOT })
  }

  readonly signalZero = (pid: number): void => {
    const entry = this.live(pid)
    if (entry === undefined) throw errno('ESRCH')
    if (entry.denied) throw errno('EPERM')
  }

  readonly sendSignal = (pid: number, signal: 'SIGTERM' | 'SIGKILL'): void => {
    if (pid === 0 || pid === -1) throw new Error(`the adapter signalled ${pid}: every process`)
    const kind = signal === 'SIGTERM' ? 'term' : 'kill'
    if (pid < 0) {
      this.sent.push({ pid: -pid, signal: kind, scope: 'group' })
      const members = [...this.table.values()].filter((e) => e.alive && e.pgid === -pid)
      if (members.length === 0) throw errno('ESRCH')
      const allowed = members.filter((e) => !e.denied)
      for (const member of allowed) this.apply(member, signal)
      if (allowed.length === 0) throw errno('EPERM')
      return
    }
    this.sent.push({ pid, signal: kind, scope: 'process' })
    const entry = this.live(pid)
    if (entry === undefined) throw errno('ESRCH')
    if (entry.denied) throw errno('EPERM')
    this.apply(entry, signal)
  }

  /** The adapter's command runner: answers taskkill (win32) the way taskkill.exe exits. */
  readonly runCommand: QueryRunner = (file, args): Promise<QueryOutcome> => {
    if (!/taskkill\.exe$/i.test(file)) {
      return Promise.resolve({ ok: false, cause: `could not start (${file} is not scripted)` })
    }
    this.taskkills.push({ file, args: [...args] })
    const pid = Number(args[args.indexOf('/PID') + 1])
    const tree = args.includes('/T')
    this.sent.push({ pid, signal: 'kill', scope: tree ? 'tree' : 'process' })
    const root = this.live(pid)
    if (root === undefined) return Promise.resolve({ ok: false, cause: 'exited with code 128' })
    if (tree)
      for (const entry of this.descendants(pid)) if (!entry.denied) this.apply(entry, 'SIGKILL')
    if (root.denied) return Promise.resolve({ ok: false, cause: 'exited with code 1' })
    this.apply(root, 'SIGKILL')
    return Promise.resolve({ ok: true, stdout: '' })
  }

  readonly snapshot = (): Promise<ReadOutcome<readonly ProcessRow[]>> =>
    Promise.resolve({
      ok: true,
      value: [...this.table.values()]
        .filter((entry) => entry.alive)
        .map((entry) => ({
          pid: entry.pid,
          ppid: entry.ppid,
          pgid: this.platform === 'win32' ? null : entry.pgid,
          startTimeMs: entry.readable ? entry.startTimeMs : null
        }))
    })

  /** Runs every task at once (no real time), recording the delay it was asked for. */
  readonly scheduler: Scheduler = {
    after: (ms, task) => {
      this.waits.push(ms)
      queueMicrotask(task)
      return { cancel: () => {} }
    }
  }

  private live(pid: number): Entry | undefined {
    const entry = this.table.get(pid)
    return entry?.alive === true ? entry : undefined
  }

  private descendants(pid: number): Entry[] {
    const found: Entry[] = []
    const queue = [pid]
    while (queue.length > 0) {
      const parent = queue.shift() as number
      for (const entry of this.table.values()) {
        if (entry.alive && entry.ppid === parent && entry.pid !== parent) {
          found.push(entry)
          queue.push(entry.pid)
        }
      }
    }
    return found
  }

  private apply(entry: Entry, signal: 'SIGTERM' | 'SIGKILL'): void {
    const ends = signal === 'SIGTERM' ? entry.endsOn === 'term' : entry.endsOn !== 'never'
    if (ends) entry.alive = false
    this.onSignal(entry.pid, signal)
  }
}

/** Boot sources that answer fixed values, or fail every read. */
export function scriptedBootSources(mode: 'working' | 'failing'): BootSourceReader {
  const failed = { ok: false, cause: 'failed for the test' } as const
  return {
    bootTimeMs: () =>
      Promise.resolve(mode === 'working' ? { ok: true, value: 1_789_000_000_000 } : failed),
    logonSessionId: () =>
      Promise.resolve(mode === 'working' ? { ok: true, value: 'S-1-5-5-0-4242' } : failed),
    sources: { bootId: 'scripted', bootTimeMs: 'scripted', logonSessionId: 'scripted' }
  }
}

/** A reader whose start-time and boot-id reads all fail. */
export const FAILING_READER: OsProcessReader = {
  startTimeMs: () => Promise.resolve({ ok: false, cause: 'failed for the test' }),
  bootId: () => Promise.resolve({ ok: false, cause: 'failed for the test' })
}
