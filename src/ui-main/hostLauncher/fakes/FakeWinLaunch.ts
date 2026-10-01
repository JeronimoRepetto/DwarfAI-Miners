// A double of the in-process launch helper (win-launch/win_launch.c) for the Windows spawner's
// tests: it records every call and lets the test play the native side (what breakaway answers,
// whether a WMI-created pid can be opened, when a watched Host exits). Never imported by production
// code (R14).
import type {
  BreakawayResult,
  HostProcessHandle,
  WinLaunchBinding,
  WmiCreateResult
} from '../win-launch/nativeWinLaunch'

export interface BreakawayCall {
  file: string
  commandLine: string
  cwd: string
  environment: string
  flags: number
}

export interface WmiCreateCall {
  commandLine: string
  cwd: string
  environment: readonly string[]
}

interface Watched {
  ms: number
  onExit: (code: number) => void
}

export class FakeWinLaunch {
  readonly breakaways: BreakawayCall[] = []
  readonly opened: number[] = []
  readonly released: HostProcessHandle[] = []
  /** What breakaway answers; default a launch. */
  answer: (process: HostProcessHandle) => BreakawayResult = (process) => ({
    status: 'launched',
    process
  })
  readonly wmiCreates: WmiCreateCall[] = []
  /** What wmiCreate settles with; default a launch of pid 4242. */
  wmiAnswer: () => Promise<WmiCreateResult> = () =>
    Promise.resolve({ status: 'launched', pid: 4242 })
  /** Whether open(pid) finds the process. */
  canOpen = true
  private readonly watches = new Map<HostProcessHandle, Watched>()
  private last: HostProcessHandle | null = null

  readonly binding: WinLaunchBinding = {
    breakaway: (file, commandLine, cwd, environment, flags) => {
      this.breakaways.push({ file, commandLine, cwd, environment, flags })
      const process = { from: 'breakaway' }
      const result = this.answer(process)
      if (result.status === 'launched') this.last = result.process
      return result
    },
    wmiCreate: (commandLine, cwd, environment) => {
      this.wmiCreates.push({ commandLine, cwd, environment })
      return this.wmiAnswer()
    },
    open: (pid) => {
      this.opened.push(pid)
      if (!this.canOpen) return null
      const process = { from: 'open', pid }
      this.last = process
      return process
    },
    watch: (process, ms, onExit) => {
      this.watches.set(process, { ms, onExit })
    },
    release: (process) => {
      this.released.push(process)
      this.watches.delete(process)
    }
  }

  /** The process breakaway or open handed out last. */
  get process(): HostProcessHandle | null {
    return this.last
  }

  /** How long the last process is watched for, or null when it is not watched. */
  watchedFor(process: HostProcessHandle | null = this.last): number | null {
    return process === null ? null : (this.watches.get(process)?.ms ?? null)
  }

  /** The native side reports `code` (the exit code, or -1: still running after the watch). */
  exit(code: number, process: HostProcessHandle | null = this.last): void {
    if (process !== null) this.watches.get(process)?.onExit(code)
  }
}
