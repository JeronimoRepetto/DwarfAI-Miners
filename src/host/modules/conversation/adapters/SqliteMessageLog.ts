// `SqliteMessageLog` (16 §4.6; 05 §3.6): a dwarf's message log over `messages` and `message_keys`
// (09 §4.4), in bound SQL only, through the kernel `SqliteDatabase` port (R11).
//
// - `append` is 09 §5.2 steps 1–2 for each entry, inside the caller's transaction (16 §2.2; outside
//   one it throws `HostInvariantError`). Step 1 claims the source key in `message_keys` FIRST:
//   0 rows changed means the key was seen before (even if its row was trimmed long ago), and the
//   entry writes nothing. Then `classifyEntry` decides: a dropped record keeps its key with
//   `message_id` NULL and no row (INV-68); an echo of a waiting DwarfAI row is merged into it
//   (`source_key` set, `pending_echo` cleared, the key points at it; INV-60); anything else is a
//   new row the key then points at. A statement failure (a CHECK, a foreign key) throws and the
//   caller's transaction rolls the whole batch back (16 §2.1).
// - It returns the rows this batch inserted, merged echoes excluded (amendment of 2026-10-02 to
//   16 §4.6). `activity_json` is left NULL: activity runs are ISSUE-101.
// - `page` reads newest first by `sort_at DESC, id DESC` (the `messages_feed` index). It returns
//   the rows `ConversationEntry` can carry: provider-keyed person, dwarf and system lines.
// - `setDelivery` and `trim` are not built yet (later: ISSUE-166, ISSUE-105).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { SqliteDatabase, SqliteParam } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ConversationEntry } from '../../suppliers'
import { classifyEntry, type FeedPageRequest, type Message } from '../domain/messages'
import type { MessageLog } from '../ports/messageLog'

export interface SqliteMessageLogDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  scope: TransactionScope
  /** Stamps `created_at` and `first_seen_at`. */
  clock: Clock
  /** Mints message ids (UUIDv7). */
  ids: IdGenerator
}

const PAGE_LIMIT = 50

const CLAIM_KEY = `INSERT INTO message_keys (source_key, dwarf_id, first_seen_at) VALUES (?, ?, ?)
  ON CONFLICT (source_key) DO NOTHING`

const WAITING_ROW = `SELECT id FROM messages WHERE dwarf_id = ? AND pending_echo = ?
  ORDER BY created_at, id LIMIT 1`

const MERGE_ECHO = `UPDATE messages SET source_key = ?, pending_echo = NULL, provider_time = ?
  WHERE id = ?`

const INSERT_ROW = `INSERT INTO messages
  (id, dwarf_id, source_key, role, text, origin, provider_time, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

const POINT_KEY = 'UPDATE message_keys SET message_id = ? WHERE source_key = ?'

const PAGE_WHERE = `WHERE dwarf_id = ? AND source_key IS NOT NULL AND role <> 'answers-record'`

const BEFORE = `AND (sort_at, id) < (SELECT sort_at, id FROM messages WHERE id = ? AND dwarf_id = ?)`

export class SqliteMessageLog implements MessageLog {
  constructor(private readonly deps: SqliteMessageLogDeps) {}

  append(
    dwarfId: DwarfId,
    entries: ConversationEntry[],
    origin: 'live-stream' | 'transcript'
  ): { inserted: number; appended: Message[] } {
    const { db, scope, clock, ids } = this.deps
    if (!scope.isInTransaction()) {
      throw new HostInvariantError('MessageLog.append runs inside the caller transaction (16 §2.2)')
    }
    const now = clock.now()
    const appended: Message[] = []
    for (const entry of entries) {
      // Step 1: claim the key; a key already claimed means this entry was seen before.
      if (db.run(CLAIM_KEY, [entry.sourceKey, dwarfId, now]).changes === 0) continue
      // The waiting DwarfAI row this entry echoes, if any (one lookup per entry).
      const waiting = entry.echoOf === undefined ? null : this.waitingRow(dwarfId, entry.echoOf)
      const disposition = classifyEntry(entry, () => waiting !== null)
      if (disposition === 'drop-keep-key') continue
      if (disposition === 'merge-echo' && waiting !== null) {
        // Step 2a: the echo of a DwarfAI row: no second bubble.
        db.run(MERGE_ECHO, [entry.sourceKey, entry.providerTime, waiting])
        db.run(POINT_KEY, [waiting, entry.sourceKey])
        continue
      }
      // Step 2b: a new row, then the key points at it.
      const message: Message = {
        id: ids.uuidv7() as MessageId,
        dwarfId,
        sourceKey: entry.sourceKey,
        role: entry.role,
        text: entry.text,
        attachments: [],
        origin,
        providerTime: entry.providerTime,
        createdAt: now
      }
      db.run(INSERT_ROW, [
        message.id,
        dwarfId,
        entry.sourceKey,
        entry.role,
        entry.text,
        origin,
        entry.providerTime,
        now
      ])
      db.run(POINT_KEY, [message.id, entry.sourceKey])
      appended.push(message)
    }
    return { inserted: appended.length, appended }
  }

  page(dwarfId: DwarfId, req: FeedPageRequest): ConversationEntry[] {
    const params: SqliteParam[] = [dwarfId]
    let sql = `SELECT source_key, role, text, provider_time FROM messages ${PAGE_WHERE}`
    if (req.before !== undefined) {
      sql += ` ${BEFORE}`
      params.push(req.before, dwarfId)
    }
    sql += ' ORDER BY sort_at DESC, id DESC LIMIT ?'
    params.push(req.limit ?? PAGE_LIMIT)
    return this.deps.db.all(sql, params).map((row) => ({
      sourceKey: String(row['source_key']),
      role: row['role'] as ConversationEntry['role'],
      text: String(row['text']),
      providerTime: row['provider_time'] === null ? null : Number(row['provider_time'])
    }))
  }

  setDelivery(
    id: MessageId,
    phase: 'sending' | 'delivered' | 'reacted' | 'failed',
    at: Instant
  ): void {
    void [id, phase, at]
    throw new HostInvariantError('MessageLog.setDelivery is not built (later: ISSUE-166)')
  }

  trim(dwarfId: DwarfId, keep: number): void {
    void [dwarfId, keep]
    throw new HostInvariantError('MessageLog.trim is not built (later: ISSUE-105)')
  }

  private waitingRow(dwarfId: DwarfId, correlation: string): string | null {
    const row = this.deps.db.all(WAITING_ROW, [dwarfId, correlation])[0]
    return row === undefined ? null : String(row['id'])
  }
}
