// Shared shapes of the per-OS kill sequences (ADR-014 items 2–4; R18: OS branching only under
// host/platform). The sequences are orchestration only: every OS read and signal is a dependency,
// so the same code runs against the real OS and against the scripted one of the L3 tests.
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'

/** One row of a process listing. `startTimeMs` is null when the OS gave none for that process. */
export interface ProcessRow {
  pid: number
  ppid: number
  /** POSIX process group; null on Windows, which has none. */
  pgid: number | null
  startTimeMs: number | null
}

/** How one signal or one taskkill went. */
export type SignalOutcome = 'delivered' | 'absent' | 'denied' | 'failed'

/** The root's identity read again now: still the recorded process, gone, or unreadable. */
export type RootCheck = 'match' | 'gone' | 'unknown'

/** 16 §2.6 "KILL wait": how long the root has to exit after the uncatchable step. */
export const KILL_WAIT_MS = 2_000

/**
 * How often a wait looks whether the root has exited (16 §2.6 "exit poll ≤ 2 s"). The package
 * gives only the bound; one liveness check per 100 ms costs nothing and ends a wait promptly.
 */
export const EXIT_POLL_INTERVAL_MS = 100

export interface KillDeps {
  target: ProcessIdentity
  /** The TERM wait (16 §2.6: 3 s): how long the root has to exit after the first step. */
  graceMs: number
  /** Re-verifies the root's identity against the OS (ADR-014 item 2). */
  checkRoot(): Promise<RootCheck>
  /** A listing of every process now, or null when it could not be read (already logged). */
  snapshot(): Promise<readonly ProcessRow[] | null>
  /** Resolves true as soon as `pid` is gone, false once `ms` passed with it still there. */
  waitForExit(pid: number, ms: number): Promise<boolean>
  /** Logs the descendants that survived the first step (ADR-014 item 3, `terminate.leftover`). */
  reportSurvivors(count: number): void
}

export interface PosixKillDeps extends KillDeps {
  /** `kill(2)`: a positive pid is one process, a negative one the process group it names. */
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): SignalOutcome
}

export interface Win32KillDeps extends KillDeps {
  /** `taskkill /PID <pid> [/T] /F` through execFile with an argv array (ADR-014 items 3–4). */
  taskkill(pid: number, tree: boolean): Promise<SignalOutcome>
}
