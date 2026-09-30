// Shared shapes of the per-OS start-time readers (R18: OS branching only under host/platform).

/** What one OS can tell about a pid's start and about the current boot. */
export interface OsProcessReader {
  /** Epoch ms the process was created, or null when it cannot be read (gone, denied, garbled). */
  startTimeMs(pid: number): Promise<number | null>
  /** The current boot's id (ADR-015 item 4 derivation), or null when it cannot be read. */
  bootId(): Promise<string | null>
}

/**
 * Runs one OS query as an argv array, never through a shell, bounded in time. Resolves its stdout,
 * or null when the query failed, timed out or exited non-zero.
 */
export type QueryRunner = (
  file: string,
  args: readonly string[],
  env?: Record<string, string>
) => Promise<string | null>
