// The conversation log's aggregate (06 §9.1; ADR-007 item 2) and the ingest rule for one entry
// (09 §5.2 steps 1–2 and "Dropped records"). Pure: no I/O, no clock read (05 §2.2, R1).
import type { AnswerRefusalReason, SourceKey } from '../../../kernel/domain/sharedContracts'
import type {
  AskId,
  DwarfId,
  Instant,
  MessageId,
  MineId,
  ProviderId
} from '../../../kernel/domain/values'

/** `MessageText` bound (06 §9.1; 09 §4.4 CHECK): UTF-8 bytes, truncated with a marker upstream. */
export const MESSAGE_TEXT_MAX_BYTES = 65_536

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

/**
 * The `ActivitySummary` of the tool steps folded into one entry (15 §1.2
 * `ConversationEntry.activity`; 10 `messages.activity_json`): one summary line per step, never tool
 * output (ADR-007 item 4). An entry with no step has none.
 */
export function activitySummaryOf(
  steps: readonly { summary: string }[] | undefined
): ActivitySummary | undefined {
  if (steps === undefined || steps.length === 0) return undefined
  return { steps: steps.length, summaries: steps.map((step) => step.summary) }
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

/** 06 §0.2 `MessageView`: the `Message` without `sourceKey`, `origin` and `askId`. */
export type MessageView = Omit<Message, 'sourceKey' | 'origin' | 'askId'>

/** The read model of one stored message (06 §0.2): what the UI sees of it. */
export function toMessageView(message: Message): MessageView {
  const { sourceKey, origin, askId, ...view } = message
  void [sourceKey, origin, askId]
  return view
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

/**
 * 14 §3.6 `FeedPage`, copied field for field like `FeedPageRequest` above (05 R2, R3): one page
 * of a dwarf's feed, newest first; `reachedStart` once the oldest stored row is in it.
 */
export interface FeedPage {
  dwarfId: DwarfId
  messages: MessageView[]
  reachedStart: boolean
}

/**
 * Owner: 06 §5.1 `DwarfRank` (crew's `domain/rank.ts`), copied as the history speaker carries it:
 * the domain imports no other module (05 R1). On any difference the owner wins and this copy is a
 * defect (a type test pins it to crew's).
 */
export type HistorySpeakerRank = 'foreman' | 'worker' | 'worker2'

/**
 * 14 §3.6 `MineHistoryView`, copied field for field like `FeedPage` above (05 R2, R3): every dwarf
 * that worked in the mine, present or departed, with its stored rows (at most 50, oldest first).
 * Amended (owner amendment F, 2026-10-07): each speaker carries its `rank` and `providerId`.
 */
export interface MineHistoryView {
  mineId: MineId
  speakers: Array<{
    dwarfId: DwarfId
    displayName: string
    rank: HistorySpeakerRank // Amended: owner amendment F, 2026-10-07
    providerId: ProviderId // Amended: owner amendment F, 2026-10-07
    departed: boolean
    messages: MessageView[]
  }>
}

/** What one ingested entry does (09 §5.2): a new row, a merge into a waiting row, or its key only. */
export type EntryDisposition = 'insert' | 'merge-echo' | 'drop-keep-key'

/** The fields of a `ConversationEntry` (15 §1.2) the rule reads; the entry itself is assignable. */
export interface EntryFlags {
  echoOf?: string
  handoffEcho?: boolean
  /** Amendment to frozen 15 §1.2 (owner-approved 2026-10-02, ISSUE-098). */
  controlPlane?: true
}

/**
 * Classifies one entry whose key was just claimed (09 §5.2 step 1). `isEchoWaiting` tells whether
 * a DwarfAI row of the same dwarf waits for that echo correlation (`messages.pending_echo`);
 * `typedEchoWaiting` whether a waiting row is the one this uncorrelated observed entry echoes
 * (`echoesTypedSend`).
 *
 * - A hand-off echo or a provider control-plane record is dropped first, whatever its
 *   correlation: neither ever renders, and a pushed delegation result has no row to merge into
 *   (INV-68).
 * - An echo of a waiting DwarfAI row is merged into it, never a second bubble (INV-60).
 * - Anything else, including an echo whose row no longer waits, is a new row.
 */
export function classifyEntry(
  entry: EntryFlags,
  isEchoWaiting: (correlation: string) => boolean,
  typedEchoWaiting = false
): EntryDisposition {
  if (entry.handoffEcho === true || entry.controlPlane === true) return 'drop-keep-key'
  if (entry.echoOf !== undefined && isEchoWaiting(entry.echoOf)) return 'merge-echo'
  if (entry.echoOf === undefined && typedEchoWaiting) return 'merge-echo'
  return 'insert'
}

/**
 * How long after a DwarfAI row was written its text, typed into an observed terminal, may come
 * back in the transcript and still be its echo (ADR-007 item 3, "exact text + time window").
 * Package gap: the package names the window but not its length. Ten minutes covers a message
 * held behind a running turn (ADR-022 `heldUntilTurnEnd`) and a catch-up read after a Host
 * restart, because the window is measured on the provider's own time of the echo, not on when
 * it was read.
 */
export const TYPED_ECHO_WINDOW_MS = 600_000

/** The provider's clock may read slightly behind the Host's on the same machine. */
export const TYPED_ECHO_SKEW_MS = 5_000

/** The fields of an observed entry the typed-echo rule reads. */
export interface TypedEchoEntry extends EntryFlags {
  role: MessageRole
  text: string
  providerTime: Instant | null
}

/**
 * Whether an entry can be the echo of a message DwarfAI typed into an observed terminal: a
 * person entry a transcript observer read with no echo correlation (the transcript cannot carry
 * the relay's), and no record that is dropped anyway.
 */
export function mayEchoTypedSend(
  entry: TypedEchoEntry,
  origin: 'live-stream' | 'transcript'
): boolean {
  return (
    origin === 'transcript' &&
    entry.role === 'person' &&
    entry.echoOf === undefined &&
    entry.handoffEcho !== true &&
    entry.controlPlane !== true
  )
}

/**
 * Whether `entry` is the transcript echo of the waiting DwarfAI row `row` (ADR-007 item 3): the
 * exact same text, at a provider time (or, without one, at `now`) inside the row's window.
 */
export function echoesTypedSend(
  entry: TypedEchoEntry,
  origin: 'live-stream' | 'transcript',
  row: { text: string; createdAt: Instant },
  now: Instant
): boolean {
  if (!mayEchoTypedSend(entry, origin) || entry.text !== row.text) return false
  const at = entry.providerTime ?? now
  return at >= row.createdAt - TYPED_ECHO_SKEW_MS && at <= row.createdAt + TYPED_ECHO_WINDOW_MS
}
