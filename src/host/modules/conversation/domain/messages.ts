// The conversation log's aggregate (06 §9.1; ADR-007 item 2) and the ingest rule for one entry
// (09 §5.2 steps 1–2 and "Dropped records"). Pure: no I/O, no clock read (05 §2.2, R1).
import type { AnswerRefusalReason, SourceKey } from '../../../kernel/domain/sharedContracts'
import type { AskId, DwarfId, Instant, MessageId } from '../../../kernel/domain/values'

/** 06 §0.2 `MessageRole` (ADR-007 item 2). */
export type MessageRole = 'person' | 'dwarf' | 'answers-record' | 'system-line'

/** Which feed produced the row (ADR-007 item 2; 10 `messages.origin`, diagnostics only). */
export type MessageOrigin = 'live-stream' | 'transcript' | 'dwarfai'

/** ADR-022 item 1 `DeliveryPhase`. */
export type DeliveryPhase = 'sending' | 'delivered' | 'reacted' | 'failed'

/** ADR-022 item 1 `DeliveryFailure`; `refused.reason` is ADR-010 item 5's type, imported. */
export type DeliveryFailure =
  | { kind: 'channel-error'; reason: string }
  | { kind: 'session-closed' }
  | { kind: 'refused'; reason: AnswerRefusalReason }
  | { kind: 'host-interrupted' }

/** ADR-022 item 1 `Delivery`: a member value of `Message` (06 §9.1). */
export interface Delivery {
  messageId: MessageId
  dwarfId: DwarfId
  kind: 'message' | 'answers-record'
  phase: DeliveryPhase
  confidence?: 'confirmed' | 'unconfirmed'
  heldUntilTurnEnd?: boolean
  failure?: DeliveryFailure
  attempts: number
  phaseAt: Instant
}

/** 06 §9.1 `ActivitySummary`: step count and one-line summaries, never tool output (INV-62). */
export interface ActivitySummary {
  steps: number
  summaries: string[]
}

/** 06 §9.1 `AttachmentMeta`: name and size only, never the bytes (INV-62). */
export interface AttachmentMeta {
  name: string
  bytes: number
}

/**
 * The aggregate `Message` (06 §9.1): ADR-007's `MessageRecord` with ADR-022's `Delivery`. There
 * is no `hidden` field: a record that must never render is not a message (INV-68).
 */
export interface Message {
  id: MessageId
  dwarfId: DwarfId
  /** UNIQUE when set; null only for a DwarfAI-originated row before its provider echo. */
  sourceKey: SourceKey | null
  role: MessageRole
  /** `MessageText`: UTF-8, ≤ 64 KiB. */
  text: string
  /** "from <dwarf>" on a delegated worker's first message only. */
  issuer?: { dwarfId: DwarfId }
  activity?: ActivitySummary
  attachments: AttachmentMeta[]
  /** Person and answers-record rows only. */
  delivery?: Delivery
  origin: MessageOrigin
  providerTime: Instant | null
  /** Answers-record rows only; at most one row per ask (INV-65). */
  askId?: AskId
  createdAt: Instant
}

/**
 * 14 §3.6 `FeedPageRequest`, copied field for field because the Host's ports never import the
 * wire package (05 R2, R3); on any difference the owner wins and this copy is a defect.
 */
export interface FeedPageRequest {
  before?: MessageId
  /** At most 50 (at most 50 rows exist per dwarf, PO #87). */
  limit?: number
}

/** What one ingested entry does (09 §5.2): a new row, a merge into a waiting row, or its key only. */
export type EntryDisposition = 'insert' | 'merge-echo' | 'drop-keep-key'

/** The fields of a `ConversationEntry` (15 §1.2) the rule reads; the entry itself is assignable. */
export interface EntryFlags {
  echoOf?: string
  handoffEcho?: boolean
}

/**
 * Classifies one entry whose key was just claimed (09 §5.2 step 1). `isEchoWaiting` tells whether
 * a DwarfAI row of the same dwarf waits for that echo correlation (`messages.pending_echo`).
 *
 * - A hand-off echo is dropped first: a pushed delegation result has no row to merge into
 *   (INV-68), whatever its correlation.
 * - An echo of a waiting DwarfAI row is merged into it, never a second bubble (INV-60).
 * - Anything else, including an echo whose row no longer waits, is a new row.
 */
export function classifyEntry(
  entry: EntryFlags,
  isEchoWaiting: (correlation: string) => boolean
): EntryDisposition {
  if (entry.handoffEcho === true) return 'drop-keep-key'
  if (entry.echoOf !== undefined && isEchoWaiting(entry.echoOf)) return 'merge-echo'
  return 'insert'
}
