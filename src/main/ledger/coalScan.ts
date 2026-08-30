/**
 * Pure readers that turn bounded slices of a historical transcript into the
 * one fact the coal backfill needs: how many tokens this session burned, for
 * which project, and when it last did anything (see #22).
 *
 * Everything here is string in, value out. The runner owns the filesystem, the
 * clock and the budget; this module owns the on-disk formats, so the exact
 * shapes both providers write are pinned by unit tests rather than discovered
 * on a user's machine.
 */

/** What one historical session contributes to the coal pile. */
export interface CoalRecord {
  /** The real project path, always taken from inside the file. */
  cwd: string
  /** Total tokens the session burned, on that provider's own accounting. */
  tokens: number
  /** Epoch ms of the newest record seen, used to prove the session is history. */
  lastRecordAt: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Parse a JSONL slice leniently.
 *
 * A byte-bounded tail almost always begins mid-line, and a head almost always
 * ends mid-line. Both show up here as a line that will not parse, so an
 * unparseable line is skipped rather than treated as corruption — which is the
 * same tolerance the live providers' jsonl readers apply.
 */
function jsonlRecords(slice: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of slice.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const record = asRecord(JSON.parse(trimmed))
      if (record !== null) records.push(record)
    } catch {
      // A partial line at either edge of the slice, or genuine junk.
    }
  }
  return records
}

/** Epoch ms for an ISO-8601 record timestamp, or null when it is unusable. */
function recordTime(value: unknown): number | null {
  const text = asNonEmptyString(value)
  if (text === null) return null
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * The four usage fields that make up a Claude turn's token cost — exactly the
 * set the live provider sums (src/main/providers/claude/parse.ts), so a
 * project's historical coal is measured the same way as its live ore.
 */
const CLAUDE_USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens'
] as const

function claudeUsageTokens(message: unknown): number | null {
  const usage = asRecord(asRecord(message)?.usage)
  if (usage === null) return null
  let total = 0
  for (const field of CLAUDE_USAGE_FIELDS) {
    const value = usage[field]
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total > 0 ? total : null
}

/**
 * Read one Claude transcript tail.
 *
 * Two things make this work on a byte-bounded tail rather than a whole file.
 * First, every line carries the session's `cwd`, so the tail alone identifies
 * the project — which matters because the `projects/` directory name is a
 * lossy encoding (`[^a-zA-Z0-9] -> '-'`) with no decoder anywhere in the app.
 * Second, the token figure is the LAST usage block, not a sum: Claude resends
 * the whole conversation each turn, so its usage numbers overlap heavily and
 * adding them up would multiply the same tokens by the number of turns.
 *
 * Returns null when the tail proves nothing — no usage, or no cwd to credit.
 */
export function claudeCoalFromTail(tail: string): CoalRecord | null {
  let cwd: string | null = null
  let tokens: number | null = null
  let lastRecordAt: number | null = null

  for (const record of jsonlRecords(tail)) {
    const at = recordTime(record.timestamp)
    if (at !== null && (lastRecordAt === null || at > lastRecordAt)) lastRecordAt = at

    const lineCwd = asNonEmptyString(record.cwd)
    if (lineCwd !== null) cwd = lineCwd

    if (record.type !== 'assistant') continue
    const usage = claudeUsageTokens(record.message)
    // Last one wins, deliberately: see above.
    if (usage !== null) tokens = usage
  }

  if (cwd === null || tokens === null || lastRecordAt === null) return null
  return { cwd, tokens, lastRecordAt }
}

/** The cwd a rollout's session_meta record declares, from the file's head. */
function codexCwd(head: string): string | null {
  for (const record of jsonlRecords(head)) {
    if (record.type !== 'session_meta') continue
    const cwd = asNonEmptyString(asRecord(record.payload)?.cwd)
    if (cwd !== null) return cwd
  }
  return null
}

/**
 * Read one Codex rollout.
 *
 * Codex writes its own running total into the rollout as an `event_msg` with
 * `payload.type: 'token_count'`, carrying `info.total_token_usage.total_tokens`.
 * The live provider ignores this and reads `threads.tokens_used` from SQLite
 * instead — which is the right call for a live session, but useless here: the
 * registry only describes threads that still exist, while the whole point of
 * the backfill is sessions that ended long ago. The rollout on disk is the
 * only durable record of what a finished session cost.
 *
 * `total_token_usage` is cumulative for the session, so the last one wins for
 * the same reason Claude's does.
 */
export function codexCoalFromRollout(head: string, tail: string): CoalRecord | null {
  const cwd = codexCwd(head)
  if (cwd === null) return null

  let tokens: number | null = null
  let lastRecordAt: number | null = null

  for (const record of jsonlRecords(tail)) {
    const at = recordTime(record.timestamp)
    if (at !== null && (lastRecordAt === null || at > lastRecordAt)) lastRecordAt = at

    if (record.type !== 'event_msg') continue
    const payload = asRecord(record.payload)
    if (payload?.type !== 'token_count') continue
    const total = asPositiveNumber(
      asRecord(asRecord(payload.info)?.total_token_usage)?.total_tokens
    )
    if (total !== null) tokens = total
  }

  if (tokens === null || lastRecordAt === null) return null
  return { cwd, tokens, lastRecordAt }
}
