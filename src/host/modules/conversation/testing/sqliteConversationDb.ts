// Test helpers over a template-database copy for conversation's SQLite tests (17 §1.5): one mine
// and two dwarfs seeded in bound SQL, and read-backs of `messages` / `message_keys` the port does
// not expose. Never imported by production code (R14).
import type { DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'

const MINE = '00000000-0000-7000-8000-0000000000f1'
export const CONVERSATION_DWARFS = [
  '00000000-0000-7000-8000-0000000000d1' as DwarfId,
  '00000000-0000-7000-8000-0000000000d2' as DwarfId
] as const

/** Seeds the mine and the two dwarfs; returns their ids. */
export function seedConversationDb(
  db: SqliteDatabase,
  runner: TransactionRunner,
  at: Instant
): readonly [DwarfId, DwarfId] {
  runner.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-one', 'mine-one', 'mine-one', 'active', ?, ?)`,
      [MINE, at, at]
    )
    CONVERSATION_DWARFS.forEach((id, n) => {
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at)
         VALUES (?, ?, 'claude', ?, 'Durin', 'foreman', 'running', 'none-yet', ?, ?)`,
        [id, MINE, `session-${n}`, at, at]
      )
    })
  })
  return CONVERSATION_DWARFS
}

export interface SqliteConversationProbe {
  seedWaitingRow(dwarfId: DwarfId, correlation: string, text: string): MessageId
  /** A DwarfAI-sent person row with its `deliveries` row in phase `sending`. */
  seedSendingRow(dwarfId: DwarfId, text: string): MessageId
  /** An "Answers:" record (no ask) with its `deliveries` row in phase `delivered`. */
  seedAnswersRecord(dwarfId: DwarfId, text: string): MessageId
  keyOf(sourceKey: string): { dwarfId: DwarfId; messageId: MessageId | null } | null
  rowCount(dwarfId: DwarfId): number
  rowIds(dwarfId: DwarfId): MessageId[]
}

export function sqliteProbe(
  db: SqliteDatabase,
  runner: TransactionRunner,
  ids: IdGenerator,
  at: Instant
): SqliteConversationProbe {
  return {
    seedWaitingRow(dwarfId, correlation, text) {
      const id = ids.uuidv7() as MessageId
      runner.inTransaction(() =>
        db.run(
          `INSERT INTO messages (id, dwarf_id, role, text, origin, pending_echo, created_at)
           VALUES (?, ?, 'person', ?, 'dwarfai', ?, ?)`,
          [id, dwarfId, text, correlation, at]
        )
      )
      return id
    },
    seedSendingRow(dwarfId, text) {
      return seedWithDelivery(dwarfId, 'person', 'message', 'sending', text)
    },
    seedAnswersRecord(dwarfId, text) {
      return seedWithDelivery(dwarfId, 'answers-record', 'answers-record', 'delivered', text)
    },
    keyOf(sourceKey) {
      const row = db.all('SELECT dwarf_id, message_id FROM message_keys WHERE source_key = ?', [
        sourceKey
      ])[0]
      if (row === undefined) return null
      const messageId = row['message_id']
      return {
        dwarfId: String(row['dwarf_id']) as DwarfId,
        messageId: messageId === null ? null : (String(messageId) as MessageId)
      }
    },
    rowCount(dwarfId) {
      return Number(
        db.all('SELECT count(*) AS n FROM messages WHERE dwarf_id = ?', [dwarfId])[0]?.['n']
      )
    },
    rowIds(dwarfId) {
      return db
        .all('SELECT id FROM messages WHERE dwarf_id = ? ORDER BY rowid', [dwarfId])
        .map((row) => String(row['id']) as MessageId)
    }
  }

  function seedWithDelivery(
    dwarfId: DwarfId,
    role: 'person' | 'answers-record',
    kind: 'message' | 'answers-record',
    phase: 'sending' | 'delivered',
    text: string
  ): MessageId {
    const id = ids.uuidv7() as MessageId
    runner.inTransaction(() => {
      db.run(
        `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at)
         VALUES (?, ?, ?, ?, 'dwarfai', ?)`,
        [id, dwarfId, role, text, at]
      )
      db.run(
        `INSERT INTO deliveries (message_id, dwarf_id, kind, phase, sent_at, phase_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, dwarfId, kind, phase, at, at]
      )
    })
    return id
  }
}
