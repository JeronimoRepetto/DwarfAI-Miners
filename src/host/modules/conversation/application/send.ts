// `ConversationCommands.send` (05 §3.6, 16 §4.6; 11 F4; 12 UC-012; ADR-022 items 1–3; 07 machine 7;
// ISSUE-166): a person's message to a dwarf as a Host command, and the hand-over that continues with
// no caller. Every mark moves only on evidence, through the pure machine 7 (domain/delivery.ts).
//
// - Acceptance (S7.01, INV-63, 14 §1.7): one transaction writes the person row with its `requestId`
//   and its `sending` delivery (`MessageLog.writeSent`, AMENDMENT-16, owner, 2026-10-15) and trims
//   the dwarf to its 50 stored rows, a `sending` row never trimmed (INV-61). Only then, after the
//   commit, `MessagesAppended` (the bubble) and `MessageSent` (the "…" mark) are published, and the
//   command answers with the `messageId`. The hand-over starts after that answer, never before the
//   row exists.
// - Refused before any row (16 §4.6): a dwarf that cannot receive (`canReceiveMessages` false,
//   INV-33) gets `cannot-receive`, and its row is rolled back with the transaction that tried it;
//   attachments are `attachment-refused` until their re-validation is built (later: ISSUE-169), so
//   nothing is offered that does not exist (21 §1 item 8).
// - Durable dedupe (14 §1.6): a `requestId` already stored — also after a Host restart — answers
//   that row's `messageId`, publishes nothing and hands nothing over. It is looked up before the
//   receive check, so a repeat is never answered `cannot-receive` for a message that was sent.
// - The hand-over (`TurnSender`, AMENDMENT-16 extension): accepted → `delivered` with the channel's
//   own `confidence` (S7.04; `unconfirmed` when the driver had no protocol ack within 30 s, FM-077 —
//   the Host adds no timeout of its own, 07 I-19); queued behind a running turn → still `sending`,
//   held (S7.03), and `delivered` when that dwarf's turn ends; `channel-error` → `failed` with
//   Retry (S7.06, FM-076); `session-closed` → `failed` with Copy alone (S7.07, FM-078). Nothing
//   retries on its own (BR-17).
// - ✓✓ (S7.05, ADR-022 item 3): only for a session whose `reactionEvidence` is `turn-id`, when the
//   turn the receipt named (`providerTurnId`) is seen ending with work done (`concluded` or
//   `capped`). `transcript-match` stays at ✓ until spike S-022-1 records its match rule (ISSUE-325),
//   and `none` never reaches ✓✓ (PO #57). No time ever moves ✓ to ✓✓ (NFR-TIM-05). The turn → message
//   correlation lives in Host memory: after a Host restart a ✓ stays ✓ (truthful; the boot
//   reconcile is ISSUE-173's).
// - Closing or reopening a window is no event here (S7.18): the snapshot `marks` section reads the
//   phase stored at that moment.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, EventId, HostEpoch, MessageId, Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { advance, startDelivery, type DeliveryFact } from '../domain/delivery'
import type { MessagesAppended } from '../domain/events'
import type { Delivery, MessageView } from '../domain/messages'
import { MESSAGES_PER_DWARF } from '../domain/retention'
import type { DeliverySettlement, MessageLog } from '../ports/messageLog'
import type { TurnHandOver, TurnSender } from '../ports/turnSender'
import type { MessageDeliveryFailed, MessageHandedOver, MessageSent } from './answerRecords'
import type { AttachmentPath, ConversationSendCommand } from './ingest'

/** 08 §0 `MessageReactedTo`: correlated activity after the message (✓✓, S7.05). */
export type MessageReactedTo = DomainEvent<
  'MessageReactedTo',
  { messageId: MessageId; dwarfId: DwarfId }
>

/** The events a send publishes, each after the commit of what it reports (16 §2.3). */
export type SendEvent =
  MessagesAppended | MessageSent | MessageHandedOver | MessageReactedTo | MessageDeliveryFailed

/** Whether a dwarf can receive a message right now (crew's derived `canReceiveMessages`, INV-33). */
export interface MessageRecipients {
  canReceiveMessages(dwarfId: DwarfId): boolean
}

export interface ConversationSendDeps {
  log: MessageLog
  /** One transaction per write (16 §2.2). */
  transactions: TransactionRunner
  /** Where the delivery events go, after the commit. */
  bus: Pick<DomainEventBus<SendEvent>, 'publish'>
  /** Subscribes to the dwarf's turn ends (`TurnEnded`, published once per turn key, 08 §4). */
  onTurnEnded(handler: (end: TurnEnded) => void): void
  turns: TurnSender
  recipients: MessageRecipients
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
}

/** The rows a dwarf can wait on for ✓✓ at once; an older one stays ✓ (bounded Host memory). */
const WATCHED_PER_DWARF = MESSAGES_PER_DWARF

class CannotReceive extends Error {}

/** A delivered message waiting for the turn that consumed it (`reactionEvidence: 'turn-id'`). */
interface Watched {
  dwarfId: DwarfId
  providerTurnId: string
}

/** A message the driver queued behind a running turn, with what its receipt said. */
interface Held {
  dwarfId: DwarfId
  receipt: TurnHandOver
}

export class ConversationSender implements ConversationSendCommand {
  /** The Host's current delivery of each message still `sending`, held, or watched for ✓✓. */
  private readonly deliveries = new Map<MessageId, Delivery>()
  private readonly held = new Map<MessageId, Held>()
  private readonly watched = new Map<MessageId, Watched>()

  constructor(private readonly deps: ConversationSendDeps) {
    deps.onTurnEnded((end) => this.turnEnded(end))
  }

  async send(
    dwarfId: DwarfId,
    text: string,
    attachments: AttachmentPath[],
    requestId: string
  ): Promise<Result<MessageId, 'cannot-receive' | 'attachment-refused'>> {
    const { log, transactions, recipients, clock } = this.deps
    if (attachments.length > 0) return { ok: false, error: 'attachment-refused' }
    const at = clock.now()
    let written: { messageId: MessageId; existing: boolean }
    try {
      written = transactions.inTransaction(() => {
        const sent = log.writeSent(dwarfId, text, requestId, at)
        if (sent.existing) return sent
        // INV-33: refused before any row — the row just written goes with the rollback.
        if (!recipients.canReceiveMessages(dwarfId)) throw new CannotReceive()
        log.trim(dwarfId, MESSAGES_PER_DWARF)
        return sent
      })
    } catch (error) {
      if (error instanceof CannotReceive) return { ok: false, error: 'cannot-receive' }
      throw error
    }
    const { messageId } = written
    if (written.existing) return { ok: true, value: messageId }

    const { delivery } = startDelivery({ messageId, dwarfId, kind: 'message', at })
    this.deliveries.set(messageId, delivery)
    const view: MessageView = {
      id: messageId,
      dwarfId,
      role: 'person',
      text,
      attachments: [],
      delivery,
      providerTime: null,
      createdAt: at
    }
    this.publish('MessagesAppended', { dwarfId, messages: [view] })
    this.publish('MessageSent', { messageId, dwarfId, kind: 'message' })
    // The hand-over continues after this answer, with no caller (14 §1.7).
    void Promise.resolve().then(() => this.handOver(dwarfId, messageId, text))
    return { ok: true, value: messageId }
  }

  private async handOver(dwarfId: DwarfId, messageId: MessageId, text: string): Promise<void> {
    let result: Awaited<ReturnType<TurnSender['send']>>
    try {
      result = await this.deps.turns.send(dwarfId, {
        messageId,
        kind: 'message',
        text,
        attachments: []
      })
    } catch {
      // A sender that throws instead of answering is a channel error, never a silent loss.
      result = { ok: false, error: { kind: 'channel-error', reason: 'the hand-over failed' } }
    }
    if (!result.ok) {
      const failure = result.error
      this.move(
        messageId,
        failure.kind === 'session-closed'
          ? { t: 'session-closed' }
          : { t: 'channel-error', reason: failure.reason }
      )
      return
    }
    const receipt = result.value
    if (receipt.heldUntilTurnEnd) {
      if (this.move(messageId, { t: 'held' })) this.held.set(messageId, { dwarfId, receipt })
      return
    }
    this.accept(dwarfId, messageId, receipt)
  }

  /** S7.04, then the ✓✓ watch when the session can correlate by turn id. */
  private accept(dwarfId: DwarfId, messageId: MessageId, receipt: TurnHandOver): void {
    if (!this.move(messageId, { t: 'accepted', confidence: receipt.confidence })) return
    // S-022-1 gate: only `turn-id` correlates here; `transcript-match` and `none` stay at ✓.
    if (receipt.reactionEvidence === 'turn-id' && receipt.providerTurnId !== undefined) {
      this.watch(messageId, { dwarfId, providerTurnId: receipt.providerTurnId })
    } else {
      this.deliveries.delete(messageId)
    }
  }

  private watch(messageId: MessageId, watched: Watched): void {
    const ofDwarf = [...this.watched].filter(([, w]) => w.dwarfId === watched.dwarfId)
    if (ofDwarf.length >= WATCHED_PER_DWARF) {
      const [oldest] = ofDwarf[0] as [MessageId, Watched]
      this.watched.delete(oldest)
      this.deliveries.delete(oldest)
    }
    this.watched.set(messageId, watched)
  }

  /** A dwarf's turn ended: its held messages are handed over, and the turn's message reacted to. */
  private turnEnded(end: TurnEnded): void {
    const released = new Set<MessageId>()
    for (const [messageId, held] of [...this.held]) {
      if (held.dwarfId !== end.dwarfId) continue
      this.held.delete(messageId)
      released.add(messageId)
      this.accept(held.dwarfId, messageId, held.receipt)
    }
    for (const [messageId, watched] of [...this.watched]) {
      if (released.has(messageId)) continue
      if (watched.dwarfId !== end.dwarfId || watched.providerTurnId !== end.turnKey) continue
      this.watched.delete(messageId)
      // ADR-022 item 3: the turn that consumed this input did work. A turn that errored or was
      // interrupted proves nothing: the mark stays ✓.
      if (end.kind === 'concluded' || end.kind === 'capped') {
        this.move(messageId, { t: 'activity-correlated', reactionEvidence: 'turn-id' })
      }
      this.deliveries.delete(messageId)
    }
  }

  /**
   * One machine-7 step of `messageId`'s current delivery: stored, then published after the commit.
   * A step the machine refuses changes nothing. Returns whether it moved.
   */
  private move(messageId: MessageId, fact: DeliveryFact): boolean {
    const current = this.deliveries.get(messageId)
    if (current === undefined) return false
    const step = advance(current, fact, this.deps.clock.now())
    if (!step.ok) return false
    const next = step.delivery
    const settlement = settlementOf(next)
    try {
      this.deps.transactions.inTransaction(() =>
        this.deps.log.settleDelivery(messageId, settlement, next.phaseAt)
      )
    } catch (error) {
      // A delivered row trimmed while it waited for ✓✓ has no mark left to move (INV-61).
      if (next.phase === 'reacted' && error instanceof HostInvariantError) {
        this.deliveries.delete(messageId)
        return false
      }
      throw error
    }
    this.deliveries.set(messageId, next)
    const { dwarfId } = next
    if (next.phase === 'failed' && next.failure !== undefined) {
      this.deliveries.delete(messageId)
      this.publish('MessageDeliveryFailed', { messageId, dwarfId, failure: next.failure })
    } else if (next.phase === 'delivered') {
      this.publish('MessageHandedOver', {
        messageId,
        dwarfId,
        confidence: next.confidence ?? 'confirmed'
      })
    } else if (next.phase === 'reacted') {
      this.publish('MessageReactedTo', { messageId, dwarfId })
    }
    // S7.03 (still sending, now held) publishes nothing: 08 has no event for it, the mark stays
    // "…", and the snapshot `marks` section carries the stored hold.
    return true
  }

  private publish<T extends SendEvent['type']>(
    type: T,
    payload: Extract<SendEvent, { type: T }>['payload']
  ): void {
    const { ids, clock, hostEpoch, bus } = this.deps
    bus.publish({
      type,
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload
    } as Extract<SendEvent, { type: T }>)
  }
}

/** What `MessageLog.settleDelivery` stores for a delivery machine 7 just produced. */
function settlementOf(delivery: Delivery): DeliverySettlement {
  switch (delivery.phase) {
    case 'sending':
      return { phase: 'sending', heldUntilTurnEnd: true }
    case 'delivered':
      return delivery.confidence === undefined
        ? { phase: 'delivered' }
        : { phase: 'delivered', confidence: delivery.confidence }
    case 'reacted':
      return { phase: 'reacted' }
    case 'failed':
      if (delivery.failure === undefined) {
        throw new HostInvariantError(`failed delivery ${delivery.messageId} has no failure`)
      }
      return { phase: 'failed', failure: delivery.failure }
  }
}
