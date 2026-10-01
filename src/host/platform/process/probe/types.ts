// Shared shapes of the per-OS start-time readers (R18: OS branching only under host/platform).

/**
 * One read of an OS fact, or why it could not be read. The cause is a short phrase that reads
 * after "<what> read", e.g. "timed out after 5000 ms", so an `'unknown'` probe can say why.
 */
export type ReadOutcome<T> = { ok: true; value: T } | { ok: false; cause: string }

/** What one OS can tell about a pid's start and about the current boot. */
export interface OsProcessReader {
  /** Epoch ms the process was created. */
  startTimeMs(pid: number): Promise<ReadOutcome<number>>
  /** The current boot's id (ADR-015 item 4 derivation). */
  bootId(): Promise<ReadOutcome<string>>
}

/** A query's stdout on a zero exit, or why it gave none (timed out, exited non-zero, not started). */
export type QueryOutcome = { ok: true; stdout: string } | { ok: false; cause: string }

/**
 * The bound on one per-process start-time query. The package names none; 5 000 ms is the bound the
 * legacy probe ran with in production (`processProbe.ts` `runProbeCommand`).
 */
export const START_TIME_QUERY_TIMEOUT_MS = 5_000

/**
 * The bound on one boot-id query, wherever it runs (probe or `currentBootIdentity`): one
 * derivation, one bound — 16 §2.6 "Boot identity read, per OS query: 2 000 ms → that field
 * 'unknown'" (AMENDMENT-3; ADR-015 item 4). Frozen: never raised here.
 */
export const BOOT_ID_QUERY_TIMEOUT_MS = 2_000

/**
 * Runs one OS query as an argv array, never through a shell, killed at `timeoutMs`. The child gets
 * this process's environment plus `env`, without the names in `dropEnv` (compared ignoring case,
 * as Windows does).
 */
export type QueryRunner = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; env?: Record<string, string>; dropEnv?: readonly string[] }
) => Promise<QueryOutcome>

/**
 * What a Windows PowerShell 5.1 child must not inherit: a `PSModulePath` set by PowerShell 7 (a
 * Host started from a UI launched in a pwsh session) makes 5.1 fail to autoload its own modules
 * (`CouldNotAutoloadMatchingModule` for Get-Process and Get-CimInstance, seen by ISSUE-315).
 */
export const POWERSHELL_DROPPED_ENV: readonly string[] = ['PSModulePath']

/** Windows PowerShell 5.1 by its full path under SystemRoot (never found on PATH). */
export function windowsPowerShell(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  return windowsSystemTool('WindowsPowerShell\\v1.0\\powershell.exe', env)
}

export const UNPARSEABLE = { ok: false, cause: 'gave an unparseable answer' } as const

/** Maps a query outcome through a parser; a parser's null is an unparseable answer. */
export function parsed<T>(
  outcome: QueryOutcome,
  parse: (stdout: string) => T | null
): ReadOutcome<T> {
  if (!outcome.ok) return outcome
  const value = parse(outcome.stdout)
  return value === null ? UNPARSEABLE : { ok: true, value }
}

/**
 * The two facts `ProcessControl.currentBootIdentity` reads beside the boot id (16 §3, AMENDMENT-3;
 * sources of ADR-015 item 4, UNVERIFIED until S-015-2). Each read is bounded by
 * BOOT_ID_QUERY_TIMEOUT_MS and answers why it failed instead of rejecting.
 */
export interface BootSourceReader {
  /**
   * The OS boot instant in epoch ms. Never on the probe path: a slow or failed read makes only this
   * field `'unknown'`, never a process identity.
   */
  bootTimeMs(): Promise<ReadOutcome<number>>
  /** The logon session of the process this runs in (the Host). */
  logonSessionId(): Promise<ReadOutcome<string>>
  /** Where each field comes from on this OS, as the L8 lane states it for the S-015-2 record. */
  readonly sources: Readonly<Record<'bootId' | 'bootTimeMs' | 'logonSessionId', string>>
}

/**
 * The absolute path of a program in Windows' own System32 folder, built from `%SystemRoot%`. Named
 * by path, never looked up on PATH: an earlier program of the same name on PATH would run instead
 * (Git for Windows ships its own `whoami` and `klist`, which take other arguments). Only when
 * `SystemRoot` is missing from the environment is the Windows default `C:\Windows` assumed.
 */
export function windowsSystemTool(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
  return `${root.replace(/[\\/]+$/, '')}\\System32\\${name}`
}

/**
 * macOS's own `ps` and `sysctl`, by path for the reason `windowsSystemTool` gives: never looked up on
 * PATH, which the person's environment decides. A PATH without /usr/sbin left the Host unable to read
 * its own identity, and an earlier entry could answer for the system tool. Both live on the sealed
 * system volume at these paths.
 */
export const DARWIN_PS = '/bin/ps'
export const DARWIN_SYSCTL = '/usr/sbin/sysctl'
