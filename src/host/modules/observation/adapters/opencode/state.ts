// OpenCode's store, `opencode.db` (15 §5 OpenCode row; docs/opencode-format.md Rows 2-4, 14), read
// through the read-only snapshot (FM-090): the queries, and the facts of the rows they return.
// Pure over the rows.
//
// - The cursor is a watermark (15 §5): the newest `time_updated` (ms) read, over the `session`,
//   `message` and `part` tables. A message is news when it or one of its parts changed at or after
//   the watermark, so a reply that was still streaming at the last read is read again once it
//   finishes (finishing updates its row). `SourceFile.size` of the store is its newest
//   `time_updated`, so a value below the cursor is a rebuilt store (FM-087).
// - OpenCode stamps a row's time before it commits, so a row stamped a little earlier than the
//   newest one read can commit after that read. Each read therefore also looks `LOOKBACK_MS`
//   before the watermark, and a row observed there before is skipped unless it changed since.
// - A read is bounded (FM-088): at most `READ_LIMIT` changed messages, oldest change first; the
//   watermark then stops at the last one read, and the rest follow next cycle.
// - Identity is the session id; a child session (a Task subagent) names its parent in
//   `session.parent_id`, the only topology (Row 4; ADR-015). An archived session is not observed.
// - Keys (15 §4.6, §5): `sourceKey = <providerId>:opencode:<sessionId>:<partId or messageId>`; an
//   entry's event id is its part id, a usage's its message id, and its `unitKey` is the assistant
//   message id, the same on the driver path (FM-094).
// - The lifetime total of a session (Row 14) is its own stream for the coal backfill (09 §5.5):
//   `streamId = <providerId>:session:<sessionId>`, `unitKey = coal:<streamId>`, newest record =
//   `session.time_updated`. It is never a live usage event: the live units are the messages.
import type { Instant, ProviderId, ProviderIdentity } from '../../../../kernel/domain/values'
import type { SqliteRow } from '../../../../kernel/ports/sqliteDatabase'
import type { ConversationEntry } from '../../../suppliers'
import type { ObservedEvent } from '../../ports/observationAdapter'
import {
  nativeDirectory,
  parseMessageData,
  parsePartData,
  spentAnything,
  type UsageTokens
} from './parse'

/** The most changed messages one read takes (FM-088). */
export const READ_LIMIT = 500

/** How far before the watermark a read looks for rows that committed late. */
export const LOOKBACK_MS = 2_000

/** The store's newest change: the size of the database source. */
export const MAX_CHANGED_SQL =
  'SELECT MAX(v) AS changed FROM (' +
  'SELECT MAX(time_updated) AS v FROM session UNION ALL ' +
  'SELECT MAX(time_updated) FROM message UNION ALL ' +
  'SELECT MAX(time_updated) FROM part)'

/** The messages of observed sessions changed at or after a watermark, oldest change first. */
export const CHANGED_MESSAGES_SQL =
  'SELECT m.id AS id, m.session_id AS session_id, m.time_created AS time_created, m.data AS data, ' +
  'MAX(m.time_updated, COALESCE((SELECT MAX(p.time_updated) FROM part p WHERE p.message_id = m.id), 0)) AS changed ' +
  'FROM message m ' +
  'WHERE (m.time_updated >= ? OR EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id AND p.time_updated >= ?)) ' +
  'AND m.session_id IN (SELECT id FROM session WHERE time_archived IS NULL) ' +
  'ORDER BY changed, m.id LIMIT ?'

/** The observed sessions created inside a watermark range, oldest first. */
export const SESSIONS_SQL =
  'SELECT id, directory, parent_id, time_created FROM session ' +
  'WHERE time_archived IS NULL AND time_created >= ? AND time_created <= ? ' +
  'ORDER BY time_created, id'

/** The parts of `count` messages, in their order. */
export function partsSql(count: number): string {
  const slots = Array.from({ length: count }, () => '?').join(', ')
  return (
    'SELECT id, message_id, time_created, data FROM part ' +
    `WHERE message_id IN (${slots}) ORDER BY time_created, id`
  )
}

/** Every observed session's lifetime counters (Row 14). */
export const LIFETIME_TOTALS_SQL =
  'SELECT id, time_updated, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, ' +
  'tokens_cache_write FROM session WHERE time_archived IS NULL ORDER BY time_created, id'

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

function asCount(value: unknown): number {
  const n = asNumber(value)
  return n === undefined || n < 0 ? 0 : Math.trunc(n)
}

/** The newest change a `MAX_CHANGED_SQL` answer holds (0 for an empty store). */
export function maxChangedOf(rows: readonly SqliteRow[]): number {
  return asNumber(rows[0]?.['changed']) ?? 0
}

/** One changed message row, read but not interpreted. */
export interface ChangedMessage {
  id: string
  sessionId: string
  createdAt: Instant
  changed: number
  data: unknown
}

/** The rows of a `CHANGED_MESSAGES_SQL` answer; a row without its ids is left out. */
export function changedMessagesOf(rows: readonly SqliteRow[]): ChangedMessage[] {
  const out: ChangedMessage[] = []
  for (const row of rows) {
    const id = asString(row['id'])
    const sessionId = asString(row['session_id'])
    const createdAt = asNumber(row['time_created'])
    const changed = asNumber(row['changed'])
    if (id === undefined || sessionId === undefined) continue
    if (createdAt === undefined || changed === undefined) continue
    out.push({ id, sessionId, createdAt, changed, data: row['data'] })
  }
  return out
}

/** What one read of the store saw, and what it observed of it. */
export interface StoreBatch {
  providerId: ProviderId
  sessions: readonly SqliteRow[]
  messages: readonly ChangedMessage[]
  parts: readonly SqliteRow[]
  /**
   * Rows already observed inside the look-back window: `s:<id>` → its creation, `m:<id>` → the
   * change it was observed at (a message changed since is observed again).
   */
  seen: ReadonlyMap<string, number>
}

export interface StoreFacts {
  events: ObservedEvent[]
  warnings: string[]
  /** The `s:<id>` / `m:<id>` keys of the rows observed, with the watermark value they sit at. */
  observed: Array<{ key: string; at: number }>
}

/** The facts of one read: sessions first, then each message's entries and usage, in order. */
export function factsOfBatch(batch: StoreBatch): StoreFacts {
  const { providerId } = batch
  const facts: StoreFacts = { events: [], warnings: [], observed: [] }
  const identityOf = (sessionId: string): ProviderIdentity => ({
    providerId,
    providerSessionId: sessionId
  })

  for (const row of batch.sessions) {
    const id = asString(row['id'])
    const directory = asString(row['directory'])
    const at = asNumber(row['time_created'])
    if (id === undefined || at === undefined || batch.seen.has(`s:${id}`)) continue
    if (directory === undefined) {
      facts.warnings.push(`unreadable session ${id}`)
      continue
    }
    const parent = asString(row['parent_id'])
    facts.events.push({
      kind: 'session',
      sourceEventId: `session:${id}`,
      identity: identityOf(id),
      cwd: nativeDirectory(directory),
      at,
      ...(parent === undefined ? {} : { parentIdentity: identityOf(parent) })
    })
    facts.observed.push({ key: `s:${id}`, at })
  }

  const partsOf = new Map<string, SqliteRow[]>()
  for (const part of batch.parts) {
    const messageId = asString(part['message_id'])
    if (messageId === undefined) continue
    const owned = partsOf.get(messageId)
    if (owned === undefined) partsOf.set(messageId, [part])
    else owned.push(part)
  }

  const inOrder = [...batch.messages].sort((a, b) =>
    a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )
  for (const row of inOrder) {
    if (batch.seen.get(`m:${row.id}`) === row.changed) continue
    const message = parseMessageData(row.data)
    if (message === null) {
      facts.warnings.push(`unreadable message ${row.id}`)
      facts.observed.push({ key: `m:${row.id}`, at: row.changed })
      continue
    }
    // A reply still being written: read again once it finishes.
    if (message.role === 'assistant' && message.completedAt === null) continue
    facts.observed.push({ key: `m:${row.id}`, at: row.changed })

    const identity = identityOf(row.sessionId)
    const keyOf = (id: string) => `${providerId}:opencode:${row.sessionId}:${id}`
    const role: ConversationEntry['role'] = message.role === 'user' ? 'person' : 'dwarf'
    for (const partRow of partsOf.get(row.id) ?? []) {
      const partId = asString(partRow['id'])
      if (partId === undefined) continue
      const part = parsePartData(partRow['data'])
      if (part === null) {
        facts.warnings.push(`unreadable part ${partId}`)
        continue
      }
      if (part.type !== 'text') continue
      facts.events.push({
        kind: 'entries',
        sourceEventId: partId,
        identity,
        entries: [
          {
            sourceKey: keyOf(partId),
            role,
            text: part.text,
            providerTime: asNumber(partRow['time_created']) ?? null
          }
        ]
      })
    }

    if (message.role === 'assistant' && message.tokens !== null && spentAnything(message.tokens)) {
      facts.events.push({
        kind: 'usage',
        sourceEventId: row.id,
        identity,
        usage: {
          sourceKey: keyOf(row.id),
          unitKey: row.id,
          fidelity: 1,
          tokens: message.tokens,
          sealed: true,
          providerTime: message.completedAt
        }
      })
    }
  }
  return facts
}

/** One session's lifetime total, the coal backfill's unit for it (09 §5.5). */
export interface OpenCodeLifetimeTotal {
  identity: ProviderIdentity
  /** `<providerId>:session:<sessionId>`: stable across Host runs and store paths. */
  streamId: string
  /** `coal:<streamId>`. */
  unitKey: string
  tokens: UsageTokens
  /** `session.time_updated`: the stream's newest record, for the honest-floor rule. */
  newestRecordAt: Instant
}

/** The lifetime totals a `LIFETIME_TOTALS_SQL` answer holds. */
export function lifetimeTotalsOf(
  rows: readonly SqliteRow[],
  providerId: ProviderId
): OpenCodeLifetimeTotal[] {
  const out: OpenCodeLifetimeTotal[] = []
  for (const row of rows) {
    const id = asString(row['id'])
    const newestRecordAt = asNumber(row['time_updated'])
    if (id === undefined || newestRecordAt === undefined) continue
    const streamId = `${providerId}:session:${id}`
    out.push({
      identity: { providerId, providerSessionId: id },
      streamId,
      unitKey: `coal:${streamId}`,
      tokens: {
        inputNet: asCount(row['tokens_input']),
        output: asCount(row['tokens_output']),
        cacheRead: asCount(row['tokens_cache_read']),
        cacheWrite: asCount(row['tokens_cache_write']),
        reasoning: asCount(row['tokens_reasoning'])
      },
      newestRecordAt
    })
  }
  return out
}
