import type { SqliteDb, SqliteRow } from '../../adapters/sqliteLike'
import {
  parseOpenCodeMessageData,
  parseOpenCodeModel,
  type OpenCodeMessage,
  type OpenCodeMessageRow,
  type OpenCodePartRow
} from './parse'

/**
 * Readers for OpenCode's SQLite store (`opencode.db` — see
 * `docs/opencode-format.md` for the verified schema). Mirrors `codex/state.ts`:
 * every reader degrades to empty on a database whose schema does not match —
 * an OpenCode build this app has not measured must fall back to "not
 * observed", never throw inside a poll tick (`sqliteLike.ts`'s error contract,
 * `all()` → `[]` on a failing query).
 *
 * `message.data`/`part.data` are handed to `parse.ts` UNPARSED — the raw
 * `TEXT` column value — so the one `JSON.parse`/`try-catch` for those blobs
 * stays inside `parse.ts`, exactly where D2 places it.
 */

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

/** One `session` row [V], the identity and placement facts a dwarf is built from. */
export interface OpenCodeSession {
  sessionId: string
  cwd: string
  title?: string
  agent?: string
  /** `parseOpenCodeModel(session.model).id` — `session.model` is JSON `{id, providerID}`. */
  modelId?: string
  /** `session.parent_id` — THE ONLY topology source. Absent for a root session. */
  parentSessionId?: string
  createdMs: number
  updatedMs: number
  /**
   * This session's own `tokens_*` columns, summed (#540). Always a number,
   * never absent — a session that has burned nothing reads as 0, which is a
   * measured fact (never mined yet), not a missing one. See
   * `opencodeUsageTokens` for exactly which columns count and why.
   */
  tokensUsed: number
}

const SESSIONS_SQL =
  'SELECT id, directory, title, agent, model, parent_id, time_created, time_updated, ' +
  'cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write ' +
  'FROM session WHERE time_archived IS NULL'

/**
 * Every token category OpenCode's own accounting tracks as spent, summed —
 * the same rule Claude's and Codex's own token figures already follow (#540).
 *
 * Claude's four usage fields (coalScan.ts's CLAUDE_USAGE_FIELDS) already cover
 * every category its API exposes; it has no separate reasoning field because
 * the Anthropic API folds extended-thinking tokens into `output_tokens` with
 * no field of their own to add. Codex's `tokens_used` (codexProvider.ts) is
 * that CLI's own already-computed grand total, taken whole with no filtering.
 * OpenCode's schema is the only one of the three that exposes reasoning as
 * its own column — but a reasoning token is exactly as burned as an output
 * one, and cache tokens are counted for the same reason Claude's
 * `cache_creation`/`cache_read` fields are: all five columns count, or the
 * figure undercounts what the session actually spent.
 *
 * Each column reads NULL as 0 rather than throwing or dropping the row: the
 * real 1.18.31 schema declares them `NOT NULL DEFAULT 0` (opencode-schema.sql)
 * so a NULL here can only come from a build this app has not measured, and
 * the degrade-to-zero rule is the same one `asNumber`'s every other caller
 * already takes for an unreadable column.
 */
function opencodeUsageTokens(row: SqliteRow): number {
  const input = asNumber(row.tokens_input) ?? 0
  const output = asNumber(row.tokens_output) ?? 0
  const reasoning = asNumber(row.tokens_reasoning) ?? 0
  const cacheRead = asNumber(row.tokens_cache_read) ?? 0
  const cacheWrite = asNumber(row.tokens_cache_write) ?? 0
  return input + output + reasoning + cacheRead + cacheWrite
}

function toSession(row: SqliteRow): OpenCodeSession | null {
  const sessionId = asString(row.id)
  const cwd = asString(row.directory)
  const createdMs = asNumber(row.time_created)
  const updatedMs = asNumber(row.time_updated)
  if (sessionId === undefined || cwd === undefined) return null
  if (createdMs === undefined || updatedMs === undefined) return null

  // `cost` is read here only to keep it beside the columns it lives among in
  // the schema; #335 decides whether and how it ever reaches a dwarf, so it
  // is deliberately not stamped onto OpenCodeSession yet.
  const session: OpenCodeSession = {
    sessionId,
    cwd,
    createdMs,
    updatedMs,
    tokensUsed: opencodeUsageTokens(row)
  }
  const title = typeof row.title === 'string' ? row.title : undefined
  if (title !== undefined) session.title = title
  const agent = asString(row.agent)
  if (agent !== undefined) session.agent = agent
  const modelRaw = asString(row.model)
  if (modelRaw !== undefined) {
    const model = parseOpenCodeModel(modelRaw)
    if (model !== null) session.modelId = model.id
  }
  const parentSessionId = asString(row.parent_id)
  if (parentSessionId !== undefined) session.parentSessionId = parentSessionId
  return session
}

/**
 * Every non-archived session [V] — `time_archived IS NOT NULL` is never a
 * candidate. `sinceMs` is currently unused by the WHERE clause and reserved
 * for the retention-floor narrowing the design's open question names (a
 * `time_updated >=` bound), kept as a parameter so that narrowing needs no
 * signature change when it lands.
 */
export function readOpenCodeSessions(db: SqliteDb, _sinceMs: number): OpenCodeSession[] {
  const sessions: OpenCodeSession[] = []
  for (const row of db.all(SESSIONS_SQL)) {
    const session = toSession(row)
    if (session !== null) sessions.push(session)
  }
  return sessions
}

const EVENT_SEQS_SQL = 'SELECT aggregate_id, MAX(seq) AS seq FROM event GROUP BY aggregate_id'

/**
 * `aggregate_id` (a session id) → its max `seq` [V] — the cleanest activity
 * signal on disk (`event_aggregate_seq_idx`, the unique `(aggregate_id, seq)`
 * index). A session whose seq grew since the previous poll is busy, whatever
 * its message rows say.
 */
export function readOpenCodeEventSeqs(db: SqliteDb): Map<string, number> {
  const seqs = new Map<string, number>()
  for (const row of db.all(EVENT_SEQS_SQL)) {
    const aggregateId = asString(row.aggregate_id)
    const seq = asNumber(row.seq)
    if (aggregateId !== undefined && seq !== undefined) seqs.set(aggregateId, seq)
  }
  return seqs
}

/**
 * The newest `role: 'assistant'` message per session, read from EVERY message
 * row rather than only the newest one — `role` lives inside the JSON `data`
 * blob, not a column, so a newer USER row cannot be skipped by SQL alone. The
 * gap this closes: a fresh user turn with no assistant reply yet must not
 * report the PREVIOUS turn's `time.completed` as if it were still open — see
 * `parse.ts`'s `readOpenCodeNewestAssistant` caller in `opencodeProvider.ts`
 * for how the `event.seq` half of D3's busy rule covers exactly that gap.
 */
export function readOpenCodeNewestAssistant(
  db: SqliteDb,
  sessionIds: readonly string[]
): Map<string, OpenCodeMessage> {
  const result = new Map<string, OpenCodeMessage>()
  if (sessionIds.length === 0) return result
  const placeholders = sessionIds.map(() => '?').join(', ')
  const sql =
    `SELECT session_id, data FROM message WHERE session_id IN (${placeholders}) ` +
    'ORDER BY session_id, time_created DESC, id DESC'
  for (const row of db.all(sql, sessionIds)) {
    const sessionId = asString(row.session_id)
    if (sessionId === undefined || result.has(sessionId)) continue
    const message = parseOpenCodeMessageData(row.data)
    if (message !== null && message.role === 'assistant') result.set(sessionId, message)
  }
  return result
}

export interface OpenCodeMessagesRead {
  messages: OpenCodeMessageRow[]
  parts: OpenCodePartRow[]
}

const MESSAGES_SQL =
  'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?'

/**
 * `message` × `part` rows for one session, ordered by `time_created, id` —
 * the measured index shape (`message_session_time_created_id_idx`,
 * `part_message_id_id_idx`). `limit` bounds which messages are read: the
 * newest `limit` are selected first (so a long-lived session costs a bounded
 * read), then put back into ascending order — the order `parse.ts`'s
 * `openCodeFeedRows`/`lastAssistantText` and this function's own callers
 * expect.
 */
export function readOpenCodeMessages(
  db: SqliteDb,
  sessionId: string,
  limit: number
): OpenCodeMessagesRead {
  const messages: OpenCodeMessageRow[] = []
  for (const row of db.all(MESSAGES_SQL, [sessionId, limit])) {
    const id = asString(row.id)
    const timeCreatedMs = asNumber(row.time_created)
    if (id === undefined || timeCreatedMs === undefined) continue
    messages.push({ id, timeCreatedMs, data: row.data })
  }
  messages.reverse()
  if (messages.length === 0) return { messages: [], parts: [] }

  const placeholders = messages.map(() => '?').join(', ')
  const partsSql =
    `SELECT id, message_id, time_created, data FROM part WHERE message_id IN (${placeholders}) ` +
    'ORDER BY time_created, id'
  const parts: OpenCodePartRow[] = []
  for (const row of db.all(
    partsSql,
    messages.map((message) => message.id)
  )) {
    const id = asString(row.id)
    const messageId = asString(row.message_id)
    const timeCreatedMs = asNumber(row.time_created)
    if (id === undefined || messageId === undefined || timeCreatedMs === undefined) continue
    parts.push({ id, messageId, timeCreatedMs, data: row.data })
  }
  return { messages, parts }
}
