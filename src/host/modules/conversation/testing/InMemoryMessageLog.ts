// The MessageLog double (16 §4.6, §2.8). Never imported by production code (R14). It lives in
// `testing/`, not `ports/fakes/`: it imports values (the entry rule, the invariant error), and
// `ports/` is type-only (05 R2) — the crew precedent (`InMemoryDwarfRepository`).
//
// The same rules as `SqliteMessageLog` (09 §5.2 steps 1–2): each entry claims its source key
// first, and a key already claimed writes nothing; a dropped record keeps its key with no row; an
// echo merges into its dwarf's waiting DwarfAI row, and an uncorrelated observed person entry into
// the oldest waiting row with its exact text inside the typed-echo window; text over 64 KiB (UTF-8) is refused like the
// `messages` CHECK; `append` runs only inside the caller's transaction. A test's transaction rolls
// it back with `snapshot` / `restore`. `trim` keeps the newest `MESSAGES_PER_DWARF` rows of the
// dwarf by the domain rule `rowsToTrim` (`sending` first), and a trimmed row's key stays with no
// row. `page` returns every stored row as a `Message` with its delivery, newest first by
// `sortAt` then id (amendment of 2026-10-05 to 16 §4.6, ISSUE-103). An entry's tool steps are kept on
// its row as its `ActivitySummary` (ISSUE-101). `setDelivery` is not built (ISSUE-166).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ConversationEntry } from '../../suppliers'
import {
  activitySummaryOf,
  classifyEntry,
  echoesTypedSend,
  MESSAGE_TEXT_MAX_BYTES,
  type Delivery,
  type DeliveryPhase,
  type FeedPageRequest,
  type Message
} from '../domain/messages'
import { MESSAGES_PER_DWARF, rowsToTrim } from '../domain/retention'
import type { MessageLog } from '../ports/messageLog'

export interface InMemoryMessageLogDeps {
  /** The caller's transaction probe (16 §2.2). */
  scope: TransactionScope
  /** Stamps `createdAt`. */
  clock: Clock
  /** Mints message ids. */
  ids: IdGenerator
}

interface StoredRow {
  message: Message
  /** `messages.pending_echo`: set only on a DwarfAI row waiting for its echo. */
  pendingEcho: string | null
  /** The row's `deliveries` row, or null when it has none. */
  delivery: Delivery | null
}

interface StoredKey {
  dwarfId: DwarfId
  messageId: MessageId | null
}

export interface InMemorySnapshot {
  rows: readonly StoredRow[]
  keys: ReadonlyMap<string, StoredKey>
}

const PAGE_LIMIT = 50
const utf8 = new TextEncoder()

export class InMemoryMessageLog implements MessageLog {
  private rows: StoredRow[] = []
  private keys = new Map<string, StoredKey>()

  constructor(private readonly deps: InMemoryMessageLogDeps) {}

  append(
    dwarfId: DwarfId,
    entries: ConversationEntry[],
    origin: 'live-stream' | 'transcript'
  ): { inserted: number; appended: Message[] } {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError('MessageLog.append runs inside the caller transaction (16 §2.2)')
    }
    const now = this.deps.clock.now()
    const appended: Message[] = []
    for (const entry of entries) {
      if (this.keys.has(entry.sourceKey)) continue
      this.keys.set(entry.sourceKey, { dwarfId, messageId: null })
      const typed =
        entry.echoOf === undefined ? this.typedEcho(dwarfId, entry, origin, now) : undefined
      const disposition = classifyEntry(
        entry,
        (c) => this.waiting(dwarfId, c) !== undefined,
        typed !== undefined
      )
      if (disposition === 'drop-keep-key') continue
      if (disposition === 'merge-echo') {
        const row = entry.echoOf === undefined ? typed : this.waiting(dwarfId, entry.echoOf)
        if (row !== undefined) {
          row.message = {
            ...row.message,
            sourceKey: entry.sourceKey,
            providerTime: entry.providerTime
          }
          row.pendingEcho = null
          this.keys.set(entry.sourceKey, { dwarfId, messageId: row.message.id })
          continue
        }
      }
      if (utf8.encode(entry.text).length > MESSAGE_TEXT_MAX_BYTES) {
        throw new HostInvariantError('message text over 64 KiB (09 §4.4 CHECK)')
      }
      const activity = activitySummaryOf(entry.activity)
      const message: Message = {
        id: this.deps.ids.uuidv7() as MessageId,
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
      this.rows.push({ message, pendingEcho: null, delivery: null })
      this.keys.set(entry.sourceKey, { dwarfId, messageId: message.id })
      appended.push(structuredClone(message))
    }
    return { inserted: appended.length, appended }
  }

  page(dwarfId: DwarfId, req: FeedPageRequest): Message[] {
    const ordered = this.rows.filter((r) => r.message.dwarfId === dwarfId).sort(newestFirst)
    let from = 0
    if (req.before !== undefined) {
      const at = ordered.findIndex((r) => r.message.id === req.before)
      if (at === -1) return []
      from = at + 1
    }
    return ordered
      .slice(from, from + (req.limit ?? PAGE_LIMIT))
      .map((r) =>
        structuredClone(r.delivery === null ? r.message : { ...r.message, delivery: r.delivery })
      )
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
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError('MessageLog.trim runs inside the caller transaction (16 §2.2)')
    }
    if (keep !== MESSAGES_PER_DWARF) {
      throw new HostInvariantError(`MessageLog.trim keeps MESSAGES_PER_DWARF rows, not ${keep}`)
    }
    const trimmed = new Set(
      rowsToTrim(
        this.rows
          .filter((r) => r.message.dwarfId === dwarfId)
          .map((r) => ({
            id: r.message.id,
            sortAt: sortAt(r.message),
            sending: r.delivery?.phase === 'sending'
          }))
      )
    )
    if (trimmed.size === 0) return
    // The row goes with its delivery; its key stays, pointing at no row (09 §5.2).
    this.rows = this.rows.filter((r) => !trimmed.has(r.message.id))
    for (const [sourceKey, key] of this.keys) {
      if (key.messageId !== null && trimmed.has(key.messageId)) {
        this.keys.set(sourceKey, { ...key, messageId: null })
      }
    }
  }

  /** Test seam: a DwarfAI-sent row waiting for `correlation` (send writes these later, ISSUE-166). */
  seedWaitingRow(dwarfId: DwarfId, correlation: string, text: string): MessageId {
    return this.seedDwarfAiRow(dwarfId, 'person', text, correlation, null)
  }

  /** Test seam: a DwarfAI-sent person row whose delivery is still `sending` (ISSUE-166 writes these). */
  seedSendingRow(dwarfId: DwarfId, text: string): MessageId {
    return this.seedDwarfAiRow(dwarfId, 'person', text, null, 'sending')
  }

  /**
   * Test seam: an "Answers:" record of `dwarfId`, delivered unless `phase` says otherwise (asking
   * writes these through `AnswerRecords`).
   */
  seedAnswersRecord(
    dwarfId: DwarfId,
    text: string,
    phase: 'sending' | 'delivered' = 'delivered'
  ): MessageId {
    return this.seedDwarfAiRow(dwarfId, 'answers-record', text, null, phase)
  }

  /**
   * Test seam for the Reset step double (09 §7.2): every row goes with its delivery except one whose
   * delivery is still `sending`; every key stays, pointing at no row once its row went.
   */
  resetKeepingSending(): void {
    if (!this.deps.scope.isInTransaction()) {
      throw new HostInvariantError('the Reset step runs inside the caller transaction (16 §2.2)')
    }
    this.rows = this.rows.filter((r) => r.delivery?.phase === 'sending')
    const kept = new Set(this.rows.map((r) => r.message.id))
    for (const [sourceKey, key] of this.keys) {
      if (key.messageId !== null && !kept.has(key.messageId)) {
        this.keys.set(sourceKey, { ...key, messageId: null })
      }
    }
  }

  /** The ids of the dwarf's stored rows, in insertion order. */
  rowIds(dwarfId: DwarfId): MessageId[] {
    return this.rows.filter((r) => r.message.dwarfId === dwarfId).map((r) => r.message.id)
  }

  keyOf(sourceKey: string): StoredKey | null {
    const key = this.keys.get(sourceKey)
    return key === undefined ? null : { ...key }
  }

  rowCount(dwarfId: DwarfId): number {
    return this.rows.filter((r) => r.message.dwarfId === dwarfId).length
  }

  snapshot(): InMemorySnapshot {
    return { rows: structuredClone(this.rows), keys: new Map(this.keys) }
  }

  restore(snapshot: InMemorySnapshot): void {
    this.rows = structuredClone([...snapshot.rows])
    this.keys = new Map(snapshot.keys)
  }

  private seedDwarfAiRow(
    dwarfId: DwarfId,
    role: 'person' | 'answers-record',
    text: string,
    pendingEcho: string | null,
    delivery: DeliveryPhase | null
  ): MessageId {
    const now = this.deps.clock.now()
    const message: Message = {
      id: this.deps.ids.uuidv7() as MessageId,
      dwarfId,
      sourceKey: null,
      role,
      text,
      attachments: [],
      origin: 'dwarfai',
      providerTime: null,
      createdAt: now
    }
    this.rows.push({
      message,
      pendingEcho,
      delivery:
        delivery === null
          ? null
          : {
              messageId: message.id,
              dwarfId,
              kind: role === 'answers-record' ? 'answers-record' : 'message',
              phase: delivery,
              attempts: 1,
              phaseAt: now
            }
    })
    return message.id
  }

  /** The oldest waiting row of the dwarf this uncorrelated observed entry echoes (ADR-007 item 3). */
  private typedEcho(
    dwarfId: DwarfId,
    entry: ConversationEntry,
    origin: 'live-stream' | 'transcript',
    now: Instant
  ): StoredRow | undefined {
    return this.rows
      .filter((r) => r.message.dwarfId === dwarfId && r.pendingEcho !== null)
      .sort((a, b) => a.message.createdAt - b.message.createdAt || compareIds(a, b))
      .find((r) => echoesTypedSend(entry, origin, r.message, now))
  }

  private waiting(dwarfId: DwarfId, correlation: string): StoredRow | undefined {
    return this.rows.find((r) => r.message.dwarfId === dwarfId && r.pendingEcho === correlation)
  }
}

function compareIds(a: StoredRow, b: StoredRow): number {
  return a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0
}

function sortAt(m: Message): number {
  return m.providerTime ?? m.createdAt
}

/** `sort_at DESC, id DESC` (the `messages_feed` index). */
function newestFirst(a: StoredRow, b: StoredRow): number {
  const x = a.message
  const y = b.message
  return sortAt(y) - sortAt(x) || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0)
}
