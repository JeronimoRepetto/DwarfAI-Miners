// Test helpers over a template-database copy for conversation's SQLite tests (17 §1.5): one mine
// and two dwarfs seeded in bound SQL, and read-backs of `messages` / `message_keys` /
// `activity_disclosures` / `outcome_lines` the ports do not expose. Never imported by production code (R14).
import type { AskId, DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { ActivityDisclosure } from '../domain/activityRun'
import type { OutcomeLine, OutcomeLinePart, TurnOutcomeKind } from '../domain/outcomeLine'

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
  /** An "Answers:" record (no ask) with its `deliveries` row in `phase` (default `delivered`). */
  seedAnswersRecord(dwarfId: DwarfId, text: string, phase?: 'sending' | 'delivered'): MessageId
  keyOf(sourceKey: string): { dwarfId: DwarfId; messageId: MessageId | null } | null
  rowCount(dwarfId: DwarfId): number
  rowIds(dwarfId: DwarfId): MessageId[]
  /** An open permission ask of `dwarfId` (the `asks` row an answers-record's `ask_id` references). */
  seedAsk(dwarfId: DwarfId, n: number): AskId
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
    seedAnswersRecord(dwarfId, text, phase = 'delivered') {
      return seedWithDelivery(dwarfId, 'answers-record', 'answers-record', phase, text)
    },
    seedAsk(dwarfId, n) {
      const id = answersAskId(n)
      runner.inTransaction(() => {
        db.run(
          `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
             opened_at)
           VALUES (?, ?, 'permission', 'driver', ?, ?, 'open', ?)`,
          [id, dwarfId, `request-${n}`, JSON.stringify({ toolName: 'Bash', requestText: 'ls' }), at]
        )
      })
      return id
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

/**
 * Every stored activity run of the dwarf, by `opened_at` then id, read back from
 * `activity_disclosures` (09 §4.4) independently of the adapter.
 */
export function storedRuns(db: SqliteDatabase, dwarfId: DwarfId): ActivityDisclosure[] {
  return db
    .all(
      `SELECT id, dwarf_id, turn_key, open, step_count, summaries_json, opened_at, closed_at
         FROM activity_disclosures WHERE dwarf_id = ? ORDER BY opened_at, id`,
      [dwarfId]
    )
    .map((row) => ({
      id: String(row['id']),
      dwarfId: String(row['dwarf_id']) as DwarfId,
      turnKey: String(row['turn_key']),
      open: Number(row['open']) === 1,
      stepCount: Number(row['step_count']),
      summaries: JSON.parse(String(row['summaries_json'])) as string[],
      openedAt: Number(row['opened_at']),
      ...(row['closed_at'] === null ? {} : { closedAt: Number(row['closed_at']) })
    }))
}

/** The dwarf's stored outcome line, read back from `outcome_lines` (09 §4.4) independently of the adapter. */
export function storedOutcome(db: SqliteDatabase, dwarfId: DwarfId): OutcomeLine | null {
  const row = db.all(
    `SELECT dwarf_id, kind, step_count, parts_json, detail, closing_words, reliability, at
       FROM outcome_lines WHERE dwarf_id = ?`,
    [dwarfId]
  )[0]
  if (row === undefined) return null
  return {
    dwarfId: String(row['dwarf_id']) as DwarfId,
    kind: String(row['kind']) as TurnOutcomeKind,
    stepCount: Number(row['step_count']),
    parts: JSON.parse(String(row['parts_json'])) as OutcomeLinePart[],
    ...(row['detail'] === null ? {} : { detail: String(row['detail']) }),
    ...(row['closing_words'] === null ? {} : { closingWords: String(row['closing_words']) }),
    reliability: String(row['reliability']) as OutcomeLine['reliability'],
    at: Number(row['at'])
  }
}

/** The id of the n-th seeded ask (the `asks.id` CHECK wants 36 characters, 09 §4.5). */
export function answersAskId(n: number): AskId {
  return `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` as AskId
}
