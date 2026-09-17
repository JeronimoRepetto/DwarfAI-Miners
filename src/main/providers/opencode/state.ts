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
}

const SESSIONS_SQL =
  'SELECT id, directory, title, agent, model, parent_id, time_created, time_updated FROM session ' +
  'WHERE time_archived IS NULL'

function toSession(row: SqliteRow): OpenCodeSession | null {
  const sessionId = asString(row.id)
  const cwd = asString(row.directory)
  const createdMs = asNumber(row.time_created)
  const updatedMs = asNumber(row.time_updated)
  if (sessionId === undefined || cwd === undefined) return null
  if (createdMs === undefined || updatedMs === undefined) return null

  const session: OpenCodeSession = { sessionId, cwd, createdMs, updatedMs }
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
