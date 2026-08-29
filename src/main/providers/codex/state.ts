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
}

/** Identity extracted from a `threads.source` value. */
export interface CodexThreadSource {
  parentThreadId?: string
  agentName?: string
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
  if (parentThreadId !== undefined) result.parentThreadId = parentThreadId
  if (agentName !== undefined) result.agentName = agentName
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
  return thread
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
