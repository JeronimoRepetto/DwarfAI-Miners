import type { SqliteDb, SqliteRow } from '../../adapters/sqliteLike'

/**
 * Readers for Codex's SQLite session registry (CODEX_HOME/state_5.sqlite and
 * logs_2.sqlite) — see docs/codex-v2-format.md for the verified schemas.
 *
 * `threads` is the authoritative registry: cwd, model and reasoning_effort sit
 * directly on the row, so a session is fully described without opening its
 * rollout. `logs` is the liveness heartbeat: rows are appended continuously
 * while a turn runs, which is the signal rollout mtimes fail to provide on
 * Windows (a rollout kept open across a long session keeps its old mtime for
 * hours while it is actively appended to).
 *
 * Every reader degrades to empty on a database whose schema does not match —
 * an older or newer Codex must make the provider fall back to rollout-only
 * detection, never throw inside a poll tick.
 */

/** One live-enough thread from state_5.sqlite. */
export interface CodexThread {
  threadId: string
  /** Normalized: the Windows extended-length prefix is stripped. */
  cwd: string
  rolloutPath: string
  model?: string
  effort?: string
  tokensUsed?: number
  /** Freshest of updated_at_ms / recency_at_ms, in epoch milliseconds. */
  updatedAtMs: number
  /** Present only for a thread spawned as a Codex sub-agent. */
  parentThreadId?: string
  agentName?: string
  /**
   * The agent definition this thread was spawned as (`/root/audit_chain_report`)
   * — the objective, and the only field that states one (#218).
   *
   * A Codex child thread is a FORK of its parent: its rollout's first
   * `role:'user'` item is the HUMAN's original prompt rather than the
   * instruction the parent gave it, and it carries no `event_msg/user_message`
   * at all, so nothing readable in the transcript says what it was asked to
   * do. The spawn blob names it, as a field.
   *
   * Present only for a spawned sub-agent, like `parentThreadId`.
   */
  agentPath?: string
  /**
   * The plain `threads.source` tag — 'cli' for a CLI/TUI session, 'vscode' for
   * the desktop app. Absent when the column carries the sub-agent spawn blob
   * instead, which is a different fact and is parsed separately above.
   *
   * Read for the message-queue capability (#97), which is proven only for
   * 'cli': the tag is the difference between a queue somebody has watched drain
   * and one nobody has.
   */
  sourceTag?: string
}

/** Identity extracted from a `threads.source` value. */
export interface CodexThreadSource {
  parentThreadId?: string
  agentName?: string
  /** The agent definition the spawn names; the objective (#218). */
  agentPath?: string
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `threads.cwd` carries the Windows extended-length prefix (`\\?\C:\...`)
 * while a rollout's session_meta.cwd does not. Without stripping it the same
 * project would aggregate into two different mines. A genuine UNC path
 * (`\\server\share`) has no `?` segment and is left alone.
 */
export function normalizeCodexCwd(cwd: string): string {
  if (cwd.startsWith('\\\\?\\UNC\\')) return `\\\\${cwd.slice(8)}`
  if (cwd.startsWith('\\\\?\\')) return cwd.slice(4)
  return cwd
}

/**
 * `threads.source` is either a plain tag ("cli", "vscode") or a JSON blob
 * describing a sub-agent spawn. Only the blob carries a parent thread.
 */
export function parseCodexThreadSource(source: unknown): CodexThreadSource {
  const text = asString(source)
  if (text === undefined || !text.startsWith('{')) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const subagent = isRecord(parsed.subagent) ? parsed.subagent : undefined
  const threadSpawn = isRecord(subagent?.thread_spawn) ? subagent.thread_spawn : undefined
  if (threadSpawn === undefined) return {}

  const result: CodexThreadSource = {}
  const parentThreadId = asString(threadSpawn.parent_thread_id)
  const agentName = asString(threadSpawn.agent_nickname)
  // Kept rather than dropped (#218). It is read verbatim: `/root/…` is the
  // agent definition's own path, and prettifying it into a sentence would be
  // this app writing an objective instead of repeating the one it was given.
  const agentPath = asString(threadSpawn.agent_path)
  if (parentThreadId !== undefined) result.parentThreadId = parentThreadId
  if (agentName !== undefined) result.agentName = agentName
  if (agentPath !== undefined) result.agentPath = agentPath
  return result
}

const THREADS_SQL =
  'SELECT id, cwd, rollout_path, model, reasoning_effort, tokens_used, ' +
  'agent_nickname, source, ' +
  'MAX(COALESCE(updated_at_ms, 0), COALESCE(recency_at_ms, 0)) AS activity_ms ' +
  'FROM threads ' +
  'WHERE archived = 0 ' +
  'AND MAX(COALESCE(updated_at_ms, 0), COALESCE(recency_at_ms, 0)) >= ? ' +
  'ORDER BY activity_ms DESC'

function toThread(row: SqliteRow): CodexThread | null {
  const threadId = asString(row.id)
  const cwd = asString(row.cwd)
  const rolloutPath = asString(row.rollout_path)
  if (threadId === undefined || cwd === undefined || rolloutPath === undefined) return null

  const thread: CodexThread = {
    threadId,
    cwd: normalizeCodexCwd(cwd),
    rolloutPath,
    updatedAtMs: asNumber(row.activity_ms) ?? 0
  }
  const model = asString(row.model)
  const effort = asString(row.reasoning_effort)
  const tokensUsed = asNumber(row.tokens_used)
  if (model !== undefined) thread.model = model
  if (effort !== undefined) thread.effort = effort
  // 0 tokens means "nothing spent yet", which is not worth surfacing.
  if (tokensUsed !== undefined && tokensUsed > 0) thread.tokensUsed = tokensUsed

  const source = parseCodexThreadSource(row.source)
  const agentName = source.agentName ?? asString(row.agent_nickname)
  if (source.parentThreadId !== undefined) thread.parentThreadId = source.parentThreadId
  if (agentName !== undefined) thread.agentName = agentName
  if (source.agentPath !== undefined) thread.agentPath = source.agentPath
  const sourceTag = plainSourceTag(row.source)
  if (sourceTag !== undefined) thread.sourceTag = sourceTag
  return thread
}

/** The plain `threads.source` tag, or undefined when it is the sub-agent blob. */
function plainSourceTag(source: unknown): string | undefined {
  const text = asString(source)
  return text === undefined || text.startsWith('{') ? undefined : text
}

/** Non-archived threads whose newest activity timestamp is at or after `sinceMs`. */
export function readCodexThreads(db: SqliteDb, sinceMs: number): CodexThread[] {
  const threads: CodexThread[] = []
  for (const row of db.all(THREADS_SQL, [sinceMs])) {
    const thread = toThread(row)
    if (thread !== null) threads.push(thread)
  }
  return threads
}

/**
 * threadId -> the Codex build that opened it, for threads that recorded one.
 *
 * Deliberately its own query rather than another column on THREADS_SQL. A
 * Codex whose `threads` table predates `cli_version` would make that query fail
 * outright, and all() maps a failing query to no rows — costing every session
 * its model, effort, token count and place in the sub-agent graph, for a
 * capability that install could not use anyway. Isolated here, the same schema
 * gap costs only the version, and the version floor then refuses the queue for
 * exactly the right reason (#97).
 *
 * A blank version is omitted rather than reported: the column is `NOT NULL
 * DEFAULT ''`, so "never written" arrives as an empty string, and that is an
 * absence, not a version.
 */
export function readCodexCliVersions(db: SqliteDb): Map<string, string> {
  const versions = new Map<string, string>()
  for (const row of db.all('SELECT id, cli_version FROM threads WHERE archived = 0')) {
    const threadId = asString(row.id)
    const version = asString(row.cli_version)
    if (threadId !== undefined && version !== undefined) versions.set(threadId, version)
  }
  return versions
}

/** childThreadId -> parentThreadId, from the sub-agent spawn graph. */
export function readCodexSpawnEdges(db: SqliteDb): Map<string, string> {
  const edges = new Map<string, string>()
  for (const row of db.all('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges')) {
    const parent = asString(row.parent_thread_id)
    const child = asString(row.child_thread_id)
    if (parent !== undefined && child !== undefined) edges.set(child, parent)
  }
  return edges
}

const HEARTBEAT_SQL =
  'SELECT thread_id, MAX(ts) AS ts FROM logs ' +
  'WHERE thread_id IS NOT NULL AND ts >= ? GROUP BY thread_id'

/**
 * threadId -> newest log timestamp in epoch milliseconds, for rows at or after
 * `sinceMs`. `logs.ts` is stored in UNIX SECONDS and indexed by
 * idx_logs_ts, so this stays an indexed range scan even on an 80MB log store.
 */
export function readCodexHeartbeats(db: SqliteDb, sinceMs: number): Map<string, number> {
  const heartbeats = new Map<string, number>()
  for (const row of db.all(HEARTBEAT_SQL, [Math.floor(sinceMs / 1_000)])) {
    const threadId = asString(row.thread_id)
    const ts = asNumber(row.ts)
    if (threadId !== undefined && ts !== undefined) heartbeats.set(threadId, ts * 1_000)
  }
  return heartbeats
}
