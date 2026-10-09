// Driven port of conversation (05 §3.6, 16 §4.6 `MessageLog`), type-only (05 R2): the dwarf's
// message log over `messages`, `message_keys` and `deliveries` (09 §4.4). Natural key → idempotent
// inserts (ADR-006): `source_key` is claimed in `message_keys` first and the key survives
// trimming. Every write runs inside the caller's transaction and never opens its own (16 §2.2).
//
// Amendment to frozen 16 §4.6 / 05 §3.6 (owner-approved 2026-10-02, ISSUE-098): `append` takes the
// feed the batch came from (`messages.origin`, 09 §4.4) and returns, beside the count, the stored
// rows this batch inserted (merged echoes excluded), so ingest can publish `MessagesAppended` with
// the new rows only (08 §0, §5.1).
//
// Amendment to frozen 16 §4.6 / 05 §3.6 (owner-approved 2026-10-05, ISSUE-103): `page` returns
// `Message[]`, every stored row of the dwarf — DwarfAI-sent rows and answers-records included,
// each with its delivery — newest first by `sort_at DESC, id DESC`, at most the limit, so
// `ConversationQueries.feed` can answer 14 §3.6 `FeedPage` (`MessageView` items, `before` a
// `MessageId`) over "every stored row" (11 F12 table, the feed tail row).
//
// Owner amendment K (2026-10-09, ISSUE-128): `writeAnswersRecord` and `settleDelivery` are the
// answers-record's writes, which `AnswerRecords` (16 §4.6) makes inside asking's critical section
// (ADR-010 items 4, 13; 09 §8.2). With `append`, `setDelivery` and `trim` they are the log's only
// writes; `trim` still never removes a `sending` row.
import type { AskId, DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { ConversationEntry } from '../../suppliers'
import type { DeliveryFailure, FeedPageRequest, Message } from '../domain/messages'

export interface MessageLog {
  // natural key → idempotent inserts (ADR-006)
  append(
    dwarfId: DwarfId,
    entries: ConversationEntry[],
    origin: 'live-stream' | 'transcript'
  ): { inserted: number; appended: Message[] }
  /** Amended: every stored row as a `Message`, newest first by `sort_at DESC, id DESC`, at most `req.limit` (default 50). */
  page(dwarfId: DwarfId, req: FeedPageRequest): Message[]
  setDelivery(
    id: MessageId,
    phase: 'sending' | 'delivered' | 'reacted' | 'failed',
    at: Instant
  ): void
  // retention (ADR-007): keep = MESSAGES_PER_DWARF (50), every stored row counts, a `sending` row is never trimmed (06 INV-61)
  trim(dwarfId: DwarfId, keep: number): void
  // Amended: 16 §4.6 MessageLog.writeAnswersRecord (owner amendment K, 2026-10-09): the ask's one
  // "Answers:" record (`role 'answers-record'`, `ask_id`, origin `dwarfai`) with its delivery
  // `sending`, stamped `at`; given `existing`, that record is updated in place instead (new text,
  // restamped, `sending` again, attempts + 1, no failure; ADR-010 item 13). Returns its id.
  writeAnswersRecord(
    dwarfId: DwarfId,
    askId: AskId,
    text: string,
    at: Instant,
    existing?: MessageId
  ): MessageId
  // Amended: 16 §4.6 MessageLog.settleDelivery (owner amendment K, 2026-10-09): the hand-over
  // result of a `sending` delivery — delivered, or failed with its ADR-022 failure — stamped `at`.
  settleDelivery(
    id: MessageId,
    result: { phase: 'delivered' } | { phase: 'failed'; failure: DeliveryFailure },
    at: Instant
  ): void
}
