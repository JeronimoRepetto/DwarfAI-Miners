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
  /**
   * Freshest of created_at_ms / updated_at_ms / recency_at_ms, in epoch
   * milliseconds. See THREADS_SQL for why creation counts.
   */
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
   * the desktop app, 'exec' for a headless run. Absent when the column carries
   * the sub-agent spawn blob instead, which is a different fact and is parsed
   * separately above.
   *
   * Read for two capabilities, and it answers them separately. The message
   * queue (#97) is proven only for 'cli': the tag is the difference between a
   * queue somebody has watched drain and one nobody has. The shape of the
   * session (#231) is what 'exec' says — see isCodexOneShotThread below.
   */
  sourceTag?: string
}

/**
 * The `threads.source` tag a headless `codex exec` run writes, as against the
 * 'cli' of a TUI somebody is sitting in front of and the 'vscode' of the
 * desktop app.
 */
export const CODEX_EXEC_SOURCE_TAG = 'exec'

/**
 * Whether this thread's whole life is one prompt and one turn (#231).
 *
 * A fact about the SESSION, not about who started it: a headless run reads its
 * instruction from stdin and exits when it finishes, so nobody can talk to it
 * whether this panel launched it or somebody typed it in a terminal. That is
 * what lets the panel refuse a message with the shape of the session rather
 * than with the generic "can't receive messages yet", which describes a gap in
 * this app instead.
 *
 * Positive evidence only. Every other tag — including one this build has never
 * seen — is false rather than "probably", because absence here costs the panel
 * a better sentence while a wrong true would have it tell somebody their live
 * session cannot be reached.
 */
export function isCodexOneShotThread(thread: { sourceTag?: string }): boolean {
  return thread.sourceTag === CODEX_EXEC_SOURCE_TAG
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

/**
 * Three activity stamps, maxed, and `created_at_ms` is one of them (#264).
 *
 * A thread row Codex has only just opened can reach the first scan carrying
 * nothing else: `updated_at_ms` is nullable and arrives NULL, `recency_at_ms`
 * is NOT NULL DEFAULT 0 and arrives 0. Both floored to 0, so the row sorted
 * before every cutoff and the reader skipped it — and a session relaunched in
 * a folder whose previous session had just aged out was rediscovered by its
 * rollout file alone, without the cwd, model, effort or queue address that
 * only the registry states. Creation is the one stamp such a row is certain
 * to have, and it is a genuine freshness signal, bounded exactly like the
 * other two: a thread created ten days ago and never touched since is still
 * older than the cutoff and still excluded.
 *
 * Safe against an older Codex for the reason readCodexCliVersions is isolated
 * from this query: a column this table lacks fails the whole statement, and
 * all() maps that to no rows. `created_at_ms` was added to `threads` BEFORE
 * `updated_at_ms` (their order in the captured schema is the order they were
 * appended), so every build that can answer the columns this query already
 * asked for can answer this one too.
 */
const THREADS_ACTIVITY_MS =
  'MAX(COALESCE(created_at_ms, 0), COALESCE(updated_at_ms, 0), COALESCE(recency_at_ms, 0))'

const THREADS_SQL =
  'SELECT id, cwd, rollout_path, model, reasoning_effort, tokens_used, ' +
  'agent_nickname, source, ' +
  `${THREADS_ACTIVITY_MS} AS activity_ms ` +
  'FROM threads ' +
  'WHERE archived = 0 ' +
  `AND ${THREADS_ACTIVITY_MS} >= ? ` +
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
