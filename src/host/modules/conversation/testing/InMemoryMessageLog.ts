// The MessageLog double (16 §4.6, §2.8). Never imported by production code (R14). It lives in
// `testing/`, not `ports/fakes/`: it imports values (the entry rule, the invariant error), and
// `ports/` is type-only (05 R2) — the crew precedent (`InMemoryDwarfRepository`).
//
// The same rules as `SqliteMessageLog` (09 §5.2 steps 1–2): each entry claims its source key
// first, and a key already claimed writes nothing; a dropped record keeps its key with no row; an
// echo merges into its dwarf's waiting DwarfAI row; text over 64 KiB (UTF-8) is refused like the
// `messages` CHECK; `append` runs only inside the caller's transaction. A test's transaction rolls
// it back with `snapshot` / `restore`. `setDelivery` and `trim` are not built (ISSUE-166, ISSUE-105).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { ConversationEntry } from '../../suppliers'
import {
  classifyEntry,
  MESSAGE_TEXT_MAX_BYTES,
  type FeedPageRequest,
  type Message
} from '../domain/messages'
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
      const disposition = classifyEntry(entry, (c) => this.waiting(dwarfId, c) !== undefined)
      if (disposition === 'drop-keep-key') continue
      if (disposition === 'merge-echo' && entry.echoOf !== undefined) {
        const row = this.waiting(dwarfId, entry.echoOf)
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
      const message: Message = {
        id: this.deps.ids.uuidv7() as MessageId,
        dwarfId,
        sourceKey: entry.sourceKey,
        role: entry.role,
        text: entry.text,
        attachments: [],
        origin,
        providerTime: entry.providerTime,
        createdAt: now
      }
      this.rows.push({ message, pendingEcho: null })
      this.keys.set(entry.sourceKey, { dwarfId, messageId: message.id })
      appended.push(structuredClone(message))
    }
    return { inserted: appended.length, appended }
  }

  page(dwarfId: DwarfId, req: FeedPageRequest): ConversationEntry[] {
    const ordered = this.rows
      .map((r) => r.message)
      .filter((m) => m.dwarfId === dwarfId)
      .sort(newestFirst)
    let from = 0
    if (req.before !== undefined) {
      const at = ordered.findIndex((m) => m.id === req.before)
      if (at === -1) return []
      from = at + 1
    }
    return ordered
      .slice(from)
      .filter(isProviderEntry)
      .slice(0, req.limit ?? PAGE_LIMIT)
      .map((m) => ({
        sourceKey: m.sourceKey,
        role: m.role,
        text: m.text,
        providerTime: m.providerTime
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

  /** Test seam: a DwarfAI-sent row waiting for `correlation` (send writes these later, ISSUE-166). */
  seedWaitingRow(dwarfId: DwarfId, correlation: string, text: string): MessageId {
    const message: Message = {
      id: this.deps.ids.uuidv7() as MessageId,
      dwarfId,
      sourceKey: null,
      role: 'person',
      text,
      attachments: [],
      origin: 'dwarfai',
      providerTime: null,
      createdAt: this.deps.clock.now()
    }
    this.rows.push({ message, pendingEcho: correlation })
    return message.id
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

  private waiting(dwarfId: DwarfId, correlation: string): StoredRow | undefined {
    return this.rows.find((r) => r.message.dwarfId === dwarfId && r.pendingEcho === correlation)
  }
}

function sortAt(m: Message): number {
  return m.providerTime ?? m.createdAt
}

function newestFirst(a: Message, b: Message): number {
  return sortAt(b) - sortAt(a) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)
}

/** A row `ConversationEntry` can carry: a provider-keyed person, dwarf or system line. */
function isProviderEntry(
  m: Message
): m is Message & { sourceKey: string; role: ConversationEntry['role'] } {
  return m.sourceKey !== null && m.role !== 'answers-record'
}
