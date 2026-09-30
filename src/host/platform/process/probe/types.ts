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

/** Runs one OS query as an argv array, never through a shell, killed at `timeoutMs`. */
export type QueryRunner = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; env?: Record<string, string> }
) => Promise<QueryOutcome>

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
