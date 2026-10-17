// `SqliteMessageLog` (16 §4.6; 05 §3.6): a dwarf's message log over `messages` and `message_keys`
// (09 §4.4), in bound SQL only, through the kernel `SqliteDatabase` port (R11).
//
// - `append` is 09 §5.2 steps 1–2 for each entry, inside the caller's transaction (16 §2.2; outside
//   one it throws `HostInvariantError`). Step 1 claims the source key in `message_keys` FIRST:
//   0 rows changed means the key was seen before (even if its row was trimmed long ago), and the
//   entry writes nothing. Then `classifyEntry` decides: a dropped record keeps its key with
//   `message_id` NULL and no row (INV-68); an echo of a waiting DwarfAI row is merged into it
//   (`source_key` set, `pending_echo` cleared, the key points at it; INV-60). An observed person
//   entry with no correlation merges into the oldest waiting row of its dwarf with the exact same
//   text inside the typed-echo window (`echoesTypedSend`, ADR-007 item 3): the transcript echo of
//   a message DwarfAI typed into the terminal. Anything else is a new row the key then points at. A statement failure (a CHECK, a foreign key) throws and the
//   caller's transaction rolls the whole batch back (16 §2.1).
// - It returns the rows this batch inserted, merged echoes excluded (amendment of 2026-10-02 to
//   16 §4.6). An entry's tool steps are stored as its `ActivitySummary` in `activity_json`
//   (ADR-007 items 2, 4; ISSUE-101), NULL when it has none.
// - `page` reads newest first by `sort_at DESC, id DESC` (the `messages_feed` index), at most the
//   limit (default 50), every stored row of the dwarf as a `Message` with its `deliveries` row
//   (amendment of 2026-10-05 to 16 §4.6, ISSUE-103): DwarfAI-sent rows and answers-records too.
//   A row's `activity_json` comes back as its `activity`.
// - `trim` is 09 §5.2 step 3, inside the caller's transaction: at most `MESSAGES_PER_DWARF` stored
//   rows of the dwarf stay, every role counted, `sending` rows ranked first so a row still being
//   handed over is kept, then the newest by `sort_at`, `id` (06 INV-61). The foreign keys of 09
//   §4.4 do the rest in the same statement: the trimmed rows' `deliveries` go, and their
//   `message_keys.message_id` and `ask_answers.message_id` become NULL; the key stays, so no
//   replay re-inserts a trimmed message. Any other `keep` is refused: the cap is a constant.
// - `writeAnswersRecord` and `settleDelivery` (owner amendment K, 2026-10-09) are the answers-record's
//   writes, inside the caller's transaction: the ask's one record (`role 'answers-record'`, `ask_id`,
//   origin `dwarfai`) with its delivery `sending`, or, given `existing`, that record updated in place
//   with its delivery `sending` again, attempts + 1 (ADR-010 item 13, 09 §8.2); then the hand-over
//   result of a `sending` delivery. Updating or settling a row that is not there is refused.
// - `writeSent` (AMENDMENT-16, owner, 2026-10-15; ISSUE-166) is the person's sent row (`role
//   'person'`, origin `dwarfai`, `request_id`) with its delivery `sending`, inside the caller's
//   transaction; a `request_id` already stored (`messages_send_request` UNIQUE, also after a Host
//   restart, 14 §1.6) inserts nothing and answers that row's id; one stored for another dwarf is
//   refused with `RequestIdOfAnotherDwarfError`. `settleDelivery` also records the
//   delivery's `confidence` and moves a `delivered` delivery to `reacted`, keeping it.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { AnswerRefusalReason } from '../../../kernel/domain/sharedContracts'
import type { AskId, DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { SqliteDatabase, SqliteParam } from '../../../kernel/ports/sqliteDatabase'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ConversationEntry } from '../../suppliers'
import {
  activitySummaryOf,
  classifyEntry,
  echoesTypedSend,
  mayEchoTypedSend,
  type ActivitySummary,
  type Delivery,
  type DeliveryFailure,
  type FeedPageRequest,
  type Message
} from '../domain/messages'
import { RequestIdOfAnotherDwarfError } from '../domain/delivery'
import { MESSAGES_PER_DWARF } from '../domain/retention'
import type { DeliverySettlement, MessageLog } from '../ports/messageLog'

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

// The waiting rows an uncorrelated observed entry may echo, oldest first (`messages_pending_echo`).
const TYPED_CANDIDATES = `SELECT id, created_at FROM messages
  WHERE dwarf_id = ? AND pending_echo IS NOT NULL AND text = ?
  ORDER BY created_at, id`

const MERGE_ECHO = `UPDATE messages SET source_key = ?, pending_echo = NULL, provider_time = ?
  WHERE id = ?`

const INSERT_ROW = `INSERT INTO messages
  (id, dwarf_id, source_key, role, text, activity_json, origin, provider_time, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

const POINT_KEY = 'UPDATE message_keys SET message_id = ? WHERE source_key = ?'

// 09 §5.2 step 3, with the cap bound rather than written in.
const TRIM = `DELETE FROM messages
 WHERE dwarf_id = ?
   AND id NOT IN (SELECT m.id FROM messages m
                    LEFT JOIN deliveries d ON d.message_id = m.id AND d.phase = 'sending'
                   WHERE m.dwarf_id = ?
                   ORDER BY (d.message_id IS NOT NULL) DESC, m.sort_at DESC, m.id DESC
                   LIMIT ?)`

// Owner amendment K: the ask's one "Answers:" record and its delivery (09 §8.2). A second record of
// the same ask is refused by `messages_one_record_per_ask`.
const INSERT_RECORD = `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at, ask_id)
  VALUES (?, ?, 'answers-record', ?, 'dwarfai', ?, ?)`

const INSERT_RECORD_DELIVERY = `INSERT INTO deliveries
  (message_id, dwarf_id, kind, phase, sent_at, phase_at)
  VALUES (?, ?, 'answers-record', 'sending', ?, ?)`

// ADR-010 item 13, 09 §8.2: same id, new text, `created_at` restamped.
const UPDATE_RECORD = `UPDATE messages SET text = ?, created_at = ?
  WHERE id = ? AND dwarf_id = ? AND ask_id = ? AND role = 'answers-record'`

// …and its delivery `sending` again: no failure, attempts + 1, sent_at / phase_at now.
const RESEND_RECORD = `UPDATE deliveries SET phase = 'sending', confidence = NULL,
    failure_kind = NULL, failure_reason = NULL, attempts = attempts + 1, sent_at = ?, phase_at = ?
  WHERE message_id = ?`

// The hand-over result of a delivery still `sending` (AMENDMENT-16: with its confidence).
const SETTLE_DELIVERY = `UPDATE deliveries SET phase = ?, confidence = ?, failure_kind = ?,
    failure_reason = ?, held_until_turn_end = 0, phase_at = ?
  WHERE message_id = ? AND phase = 'sending'`

// AMENDMENT-16 extension: a `sending` delivery queued behind a running turn (S7.03); the phase
// and its stamp stay.
const HOLD_DELIVERY = `UPDATE deliveries SET held_until_turn_end = 1
  WHERE message_id = ? AND phase = 'sending'`

// AMENDMENT-16: ✓✓ only from ✓; the confidence stays.
const REACT_DELIVERY = `UPDATE deliveries SET phase = 'reacted', phase_at = ?
  WHERE message_id = ? AND phase = 'delivered'`

// AMENDMENT-16: the person's sent row and its delivery (09 §4.4, 14 §1.6).
const SENT_BY_REQUEST = 'SELECT id, dwarf_id FROM messages WHERE request_id = ?'

const INSERT_SENT = `INSERT INTO messages (id, dwarf_id, role, text, origin, created_at, request_id)
  VALUES (?, ?, 'person', ?, 'dwarfai', ?, ?)`

const INSERT_SENT_DELIVERY = `INSERT INTO deliveries
  (message_id, dwarf_id, kind, phase, sent_at, phase_at)
  VALUES (?, ?, 'message', 'sending', ?, ?)`

const PAGE_SELECT = `SELECT m.id, m.dwarf_id, m.source_key, m.role, m.text, m.issuer_dwarf_id,
    m.activity_json, m.attachments_json, m.origin, m.provider_time, m.created_at, m.ask_id,
    d.kind, d.phase, d.confidence, d.held_until_turn_end, d.failure_kind, d.failure_reason,
    d.attempts, d.phase_at
  FROM messages m LEFT JOIN deliveries d ON d.message_id = m.id
  WHERE m.dwarf_id = ?`

const BEFORE = `AND (m.sort_at, m.id) < (SELECT sort_at, id FROM messages WHERE id = ? AND dwarf_id = ?)`

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
      const waiting =
        entry.echoOf !== undefined
          ? this.waitingRow(dwarfId, entry.echoOf)
          : this.typedEchoRow(dwarfId, entry, origin, now)
      const disposition = classifyEntry(
        entry,
        () => waiting !== null,
        entry.echoOf === undefined && waiting !== null
      )
      if (disposition === 'drop-keep-key') continue
      if (disposition === 'merge-echo' && waiting !== null) {
        // Step 2a: the echo of a DwarfAI row: no second bubble.
        db.run(MERGE_ECHO, [entry.sourceKey, entry.providerTime, waiting])
        db.run(POINT_KEY, [waiting, entry.sourceKey])
        continue
      }
      // Step 2b: a new row, then the key points at it.
      const activity = activitySummaryOf(entry.activity)
      const message: Message = {
        id: ids.uuidv7() as MessageId,
        dwarfId,
        sourceKey: entry.sourceKey,
        role: entry.role,
        text: entry.text,
        ...(activity === undefined ? {} : { activity }),
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
        activity === undefined ? null : JSON.stringify(activity),
        origin,
        entry.providerTime,
        now
      ])
      db.run(POINT_KEY, [message.id, entry.sourceKey])
      appended.push(message)
    }
    return { inserted: appended.length, appended }
  }

  page(dwarfId: DwarfId, req: FeedPageRequest): Message[] {
    const params: SqliteParam[] = [dwarfId]
    let sql = PAGE_SELECT
    if (req.before !== undefined) {
      sql += ` ${BEFORE}`
      params.push(req.before, dwarfId)
    }
    sql += ' ORDER BY m.sort_at DESC, m.id DESC LIMIT ?'
    params.push(req.limit ?? PAGE_LIMIT)
    return this.deps.db.all(sql, params).map(messageOf)
  }

  trim(dwarfId: DwarfId, keep: number): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError('MessageLog.trim runs inside the caller transaction (16 §2.2)')
    }
    if (keep !== MESSAGES_PER_DWARF) {
      throw new HostInvariantError(`MessageLog.trim keeps MESSAGES_PER_DWARF rows, not ${keep}`)
    }
    this.deps.db.run(TRIM, [dwarfId, dwarfId, keep])
  }

  writeAnswersRecord(
    dwarfId: DwarfId,
    askId: AskId,
    text: string,
    at: Instant,
    existing?: MessageId
  ): MessageId {
    const { db, ids } = this.deps
    this.requireTransaction('writeAnswersRecord')
    if (existing !== undefined) {
      // ADR-010 item 13: the re-answer updates the record and its delivery in place.
      if (db.run(UPDATE_RECORD, [text, at, existing, dwarfId, askId]).changes !== 1) {
        throw new HostInvariantError(`no answers-record ${existing} of ask ${askId} to update`)
      }
      db.run(RESEND_RECORD, [at, at, existing])
      return existing
    }
    const id = ids.uuidv7() as MessageId
    db.run(INSERT_RECORD, [id, dwarfId, text, at, askId])
    db.run(INSERT_RECORD_DELIVERY, [id, dwarfId, at, at])
    return id
  }

  settleDelivery(id: MessageId, result: DeliverySettlement, at: Instant): void {
    this.requireTransaction('settleDelivery')
    if (result.phase === 'sending') {
      if (this.deps.db.run(HOLD_DELIVERY, [id]).changes !== 1) {
        throw new HostInvariantError(`no sending delivery of message ${id}`)
      }
      return
    }
    if (result.phase === 'reacted') {
      if (this.deps.db.run(REACT_DELIVERY, [at, id]).changes !== 1) {
        throw new HostInvariantError(`no delivered delivery of message ${id}`)
      }
      return
    }
    const failure = result.phase === 'failed' ? result.failure : null
    const confidence = result.phase === 'delivered' ? (result.confidence ?? null) : null
    const changes = this.deps.db.run(SETTLE_DELIVERY, [
      result.phase,
      confidence,
      failure?.kind ?? null,
      failure !== null && 'reason' in failure ? failure.reason : null,
      at,
      id
    ]).changes
    if (changes !== 1) throw new HostInvariantError(`no sending delivery of message ${id}`)
  }

  writeSent(
    dwarfId: DwarfId,
    text: string,
    requestId: string,
    at: Instant
  ): { messageId: MessageId; existing: boolean } {
    const { db, ids } = this.deps
    this.requireTransaction('writeSent')
    const [stored] = db.all(SENT_BY_REQUEST, [requestId])
    if (stored !== undefined) {
      // UNIQUE across the table: another dwarf's request id is refused, never answered with its row.
      if (String(stored['dwarf_id']) !== dwarfId) throw new RequestIdOfAnotherDwarfError()
      return { messageId: String(stored['id']) as MessageId, existing: true }
    }
    const messageId = ids.uuidv7() as MessageId
    db.run(INSERT_SENT, [messageId, dwarfId, text, at, requestId])
    db.run(INSERT_SENT_DELIVERY, [messageId, dwarfId, at, at])
    return { messageId, existing: false }
  }

  private requireTransaction(method: string): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError(
        `MessageLog.${method} runs inside the caller transaction (16 §2.2)`
      )
    }
  }

  /** The waiting DwarfAI row an uncorrelated observed entry echoes, if any (ADR-007 item 3). */
  private typedEchoRow(
    dwarfId: DwarfId,
    entry: ConversationEntry,
    origin: 'live-stream' | 'transcript',
    now: Instant
  ): string | null {
    if (!mayEchoTypedSend(entry, origin)) return null
    const row = this.deps.db
      .all(TYPED_CANDIDATES, [dwarfId, entry.text])
      .find((r) =>
        echoesTypedSend(
          entry,
          origin,
          { text: entry.text, createdAt: Number(r['created_at']) },
          now
        )
      )
    return row === undefined ? null : String(row['id'])
  }

  private waitingRow(dwarfId: DwarfId, correlation: string): string | null {
    const row = this.deps.db.all(WAITING_ROW, [dwarfId, correlation])[0]
    return row === undefined ? null : String(row['id'])
  }
}

type Row = Record<string, unknown>

const text = (row: Row, column: string): string => String(row[column])
const optionalText = (row: Row, column: string): string | null =>
  row[column] === null || row[column] === undefined ? null : String(row[column])
const optionalNumber = (row: Row, column: string): number | null =>
  row[column] === null || row[column] === undefined ? null : Number(row[column])

/** One `messages` row, with its `deliveries` row when it has one, as the aggregate `Message`. */
function messageOf(row: Row): Message {
  const id = text(row, 'id') as MessageId
  const dwarfId = text(row, 'dwarf_id') as DwarfId
  const issuer = optionalText(row, 'issuer_dwarf_id')
  const askId = optionalText(row, 'ask_id')
  const activity = optionalText(row, 'activity_json')
  return {
    id,
    dwarfId,
    sourceKey: optionalText(row, 'source_key'),
    role: text(row, 'role') as Message['role'],
    text: text(row, 'text'),
    ...(issuer === null ? {} : { issuer: { dwarfId: issuer as DwarfId } }),
    ...(activity === null ? {} : { activity: JSON.parse(activity) as ActivitySummary }),
    attachments: JSON.parse(text(row, 'attachments_json')) as Message['attachments'],
    ...(row['phase'] === null || row['phase'] === undefined
      ? {}
      : { delivery: deliveryOf(row, id, dwarfId) }),
    origin: text(row, 'origin') as Message['origin'],
    providerTime: optionalNumber(row, 'provider_time'),
    ...(askId === null ? {} : { askId: askId as AskId }),
    createdAt: Number(row['created_at'])
  }
}

/** The `deliveries` columns of a joined row as ADR-022 `Delivery`. */
function deliveryOf(row: Row, messageId: MessageId, dwarfId: DwarfId): Delivery {
  const confidence = optionalText(row, 'confidence')
  const failureKind = optionalText(row, 'failure_kind')
  const failure = failureOf(failureKind, optionalText(row, 'failure_reason'))
  return {
    messageId,
    dwarfId,
    kind: text(row, 'kind') as Delivery['kind'],
    phase: text(row, 'phase') as Delivery['phase'],
    ...(confidence === null ? {} : { confidence: confidence as 'confirmed' | 'unconfirmed' }),
    ...(Number(row['held_until_turn_end']) === 1 ? { heldUntilTurnEnd: true } : {}),
    ...(failure === undefined ? {} : { failure }),
    attempts: Number(row['attempts']),
    phaseAt: Number(row['phase_at'])
  }
}

/** `deliveries.failure_kind` and `failure_reason` as ADR-022 `DeliveryFailure`. */
function failureOf(kind: string | null, reason: string | null): DeliveryFailure | undefined {
  switch (kind) {
    case null:
      return undefined
    case 'channel-error':
      return { kind, reason: reason ?? '' }
    case 'refused':
      return { kind, reason: reason as AnswerRefusalReason }
    case 'session-closed':
    case 'host-interrupted':
      return { kind }
    default:
      throw new HostInvariantError(`unknown deliveries.failure_kind: ${kind}`)
  }
}
