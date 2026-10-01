// The Host launcher's ports (ADR-002 D3, D4, D6): what ensureHostRunning needs from the OS, each
// with a Node adapter beside it (gateFiles.ts, processStart.ts, readiness.ts, posix.ts,
// windows.ts) and a hand-written double under fakes/ (17 §2.2).
import type { HelloOk } from '@dwarfai/contracts'

/** Epoch milliseconds. The composition binds `Date.now`; tests bind a fake. */
export interface LauncherClock {
  now(): number
}

/** Waits `ms`; the composition binds a timer, tests advance a fake clock. */
export type Sleep = (ms: number) => Promise<void>

/**
 * The spawn gate file `<hostDataDir>/run/spawn.gate` (ADR-002 D3). Every operation is atomic on
 * its own; the gate's rules live in spawnGate.ts.
 */
export interface GateFiles {
  /** Creates the gate with `content` only if no gate exists, in one step (exclusive create). */
  create(content: string): Promise<'created' | 'exists'>
  /** The gate's content, or null when there is no gate. */
  read(): Promise<string | null>
  /** Removes the gate only if its content is still `content`; true when it removed it. */
  removeIf(content: string): Promise<boolean>
}

/** A process as ADR-014 item 1 identifies it here: pid plus OS creation time. */
export interface ProcessStart {
  pid: number
  processStartTimeMs: number
}

/**
 * Whether the process `(pid, processStartTimeMs)` is still the live process with that pid (ADR-002
 * D3: a gate is taken over only once its owner's identity no longer matches a live process).
 */
export type ProcessIdentityProbe = (owner: ProcessStart) => Promise<boolean>

/** One connect-and-`hello` attempt at the Host's UI endpoint (ADR-002 D4 item 1). */
export type HelloAnswer =
  /** Nothing listens: no endpoint, connection refused, or a stale socket file. */
  | { kind: 'unreachable' }
  /** A Host answered `hello.ok`. */
  | { kind: 'hello-ok'; state: HelloOk['state']; jobStatus: HelloOk['jobStatus'] }
  /** A Host answered with a protocol `error` frame (for instance AUTH_FAILED before it wrote its token). */
  | { kind: 'refused'; code: string }
  /** Something accepted the connection and sent no seam-B answer in time. */
  | { kind: 'no-answer' }

export type HelloProber = () => Promise<HelloAnswer>

/** What the launcher starts: the executable, its argv, its environment and working folder. */
export interface HostSpawnRequest {
  file: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  cwd: string
}

/** A Host process the launcher started, as far as the UI can still see it. */
export interface LaunchedHost {
  /** How it was started (ADR-002 D6): logged as the cause class, never with the pid. */
  how: 'breakaway' | 'wmi' | 'detached'
  /**
   * Its exit code if it exits while the UI still watches it, or null when it can no longer be
   * watched. Never resolves while it runs and is watched.
   */
  exited: Promise<number | null>
  /** Stops watching; the Host itself keeps running. */
  release(): void
}

export type LaunchOutcome =
  | { kind: 'launched'; host: LaunchedHost }
  /** Windows: the Host could not be started outside the UI's job (breakaway refused and WMI failed). */
  | { kind: 'in-job'; errCode: string }
  | { kind: 'failed'; errCode: string }

/** Starts the Host detached from the UI, the per-OS way of ADR-002 D6. */
export type HostSpawner = (request: HostSpawnRequest) => Promise<LaunchOutcome>

/**
 * The versioned copy the Host starts from (ADR-002 D5; ADR-027 item 2): `host/<version>/` made or
 * reused (versionedCopy.ts), then the old copies collected (versionedCopyGc.ts).
 */
export type PreparedHostCopy =
  | {
      ok: true
      /** The app directory the copy was made from. */
      sourceDir: string
      /** Where that directory's copy is: the executable and a packaged entry are found inside it. */
      contentDir: string
    }
  | { ok: false; errCode: string }

/** Prepares the copy; called only with the spawn gate held, right before the spawn (UC-002). */
export type HostCopyPreparer = () => Promise<PreparedHostCopy>
