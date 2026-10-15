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
// - Durable dedupe (14 §1.6): a `requestId` already stored for this dwarf — also after a Host
//   restart — answers that row's `messageId`, publishes nothing and hands nothing over. It is looked
//   up before the receive check, so a repeat is never answered `cannot-receive` for a message that
//   was sent. One stored for another dwarf is refused (`RequestIdOfAnotherDwarfError`).
// - The hand-over (`TurnSender`, AMENDMENT-16 extension): accepted → `delivered` with the channel's
//   own `confidence` (S7.04; `unconfirmed` when the driver had no protocol ack within 30 s, FM-077 —
//   the Host adds no timeout of its own, 07 I-19); queued behind a running turn → still `sending`,
//   held (S7.03), and `delivered` only when the turn it waits behind ends with work done; held when
//   the session ends → `failed` (S7.07); `channel-error` → `failed` with Retry (S7.06, FM-076);
//   `session-closed` → `failed` with Copy alone (S7.07, FM-078). Nothing retries on its own (BR-17).
// - ✓✓ (S7.05, ADR-022 item 3): only for a session whose `reactionEvidence` is `turn-id`, when the
//   turn the receipt named (`providerTurnId`) is seen ending with work done (`concluded` or
//   `capped`) — also when that turn ended before the receipt came back. `transcript-match` stays at
//   ✓ until spike S-022-1 records its match rule (ISSUE-325), and `none` never reaches ✓✓ (PO #57).
//   No time ever moves ✓ to ✓✓ (NFR-TIM-05). The turn → message correlation lives in Host memory:
//   after a Host restart a ✓ stays ✓ (truthful; the boot reconcile is ISSUE-173's).
// - Nothing here throws into the Host: the hand-over runs with no caller and the `TurnEnded`
//   subscriber runs on the bus, where a throw would end the Host (wiring/uncaught.ts). A delivery
//   whose row went away ends its tracking quietly; any other failed write is logged with
//   allowlisted fields only (ADR-026), never the text, and its tracking ends.
// - Closing or reopening a window is no event here (S7.18): the snapshot `marks` section reads the
//   phase stored at that moment.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, EventId, HostEpoch, MessageId, Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
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
  /** Where a failed delivery write is recorded, allowlisted fields only (ADR-026). */
  diagnostics: DiagnosticsLog
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

/**
 * A hand-over the sender has not answered yet, with what happened to its dwarf meanwhile, so a turn
 * end or a session end that comes before the receipt is applied when the receipt comes.
 */
interface InFlight {
  dwarfId: DwarfId
  endsSeen: TurnEnded[]
  sessionEnded: boolean
}

/** A turn end that proves the dwarf did work in it (ADR-021 kinds; ADR-022 item 3). */
function workDone(end: TurnEnded): boolean {
  return end.kind === 'concluded' || end.kind === 'capped'
}

/** The errno-like code of a failure, never its message (ADR-026 allowlist). */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' || typeof code === 'number') return String(code)
    if (error instanceof Error) return error.name
  }
  return 'unknown'
}

export class ConversationSender implements ConversationSendCommand {
  /** The Host's current delivery of each message still `sending`, held, or watched for ✓✓. */
  private readonly deliveries = new Map<MessageId, Delivery>()
  private readonly inFlight = new Map<MessageId, InFlight>()
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
    this.inFlight.set(messageId, { dwarfId, endsSeen: [], sessionEnded: false })
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
    // The hand-over continues after this answer, with no caller (14 §1.7). It never rejects: an
    // unhandled rejection would end the Host (wiring/uncaught.ts).
    void Promise.resolve()
      .then(() => this.handOver(dwarfId, messageId, text))
      .catch((error: unknown) => this.dropAfter(error, messageId, dwarfId))
    return { ok: true, value: messageId }
  }

  /**
   * The dwarf's session ended or the dwarf departed (the route of `recordSessionEnd`, AMENDMENT-10):
   * a held message fails `session-closed` (S7.07, US-OBS-005.AC04), a hand-over still in flight
   * learns it for its receipt, and a delivered message stays ✓ with nothing left to watch (S7.17).
   */
  sessionEnded(dwarfId: DwarfId): void {
    for (const flight of this.inFlight.values()) {
      if (flight.dwarfId === dwarfId) flight.sessionEnded = true
    }
    for (const [messageId, held] of [...this.held]) {
      if (held.dwarfId !== dwarfId) continue
      this.held.delete(messageId)
      this.move(messageId, { t: 'session-closed' })
    }
    for (const [messageId, watched] of [...this.watched]) {
      if (watched.dwarfId === dwarfId) this.forget(messageId)
    }
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
    const flight = this.inFlight.get(messageId)
    this.inFlight.delete(messageId)
    if (flight === undefined) return
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
    if (!receipt.heldUntilTurnEnd) {
      this.accept(dwarfId, messageId, receipt, flight.endsSeen)
      return
    }
    // Queued behind a running turn: the session ended meanwhile → S7.07; the turn it waited behind
    // already ended with work done → handed over now (S7.04); else held until that happens (S7.03).
    if (flight.sessionEnded) {
      this.move(messageId, { t: 'session-closed' })
      return
    }
    if (!this.move(messageId, { t: 'held' })) return
    const blocking = flight.endsSeen.find(
      (end) => workDone(end) && end.turnKey !== receipt.providerTurnId
    )
    if (blocking !== undefined) this.accept(dwarfId, messageId, receipt, flight.endsSeen)
    else this.held.set(messageId, { dwarfId, receipt })
  }

  /**
   * S7.04, then ✓✓ when the session correlates by turn id: at once when the turn that consumed the
   * message already ended with work done (`endsSeen`), else watched for that turn's end.
   */
  private accept(
    dwarfId: DwarfId,
    messageId: MessageId,
    receipt: TurnHandOver,
    endsSeen: readonly TurnEnded[]
  ): void {
    if (!this.move(messageId, { t: 'accepted', confidence: receipt.confidence })) return
    // S-022-1 gate: only `turn-id` correlates here; `transcript-match` and `none` stay at ✓.
    const turnId = receipt.reactionEvidence === 'turn-id' ? receipt.providerTurnId : undefined
    if (turnId === undefined) {
      this.forget(messageId)
      return
    }
    const own = endsSeen.find((end) => end.turnKey === turnId)
    if (own === undefined) {
      this.watch(messageId, { dwarfId, providerTurnId: turnId })
      return
    }
    // ADR-022 item 3: a turn that errored or was interrupted proves nothing: the mark stays ✓.
    if (workDone(own)) {
      this.move(messageId, { t: 'activity-correlated', reactionEvidence: 'turn-id' })
    }
    this.forget(messageId)
  }

  private watch(messageId: MessageId, watched: Watched): void {
    const ofDwarf = [...this.watched].filter(([, w]) => w.dwarfId === watched.dwarfId)
    if (ofDwarf.length >= WATCHED_PER_DWARF) {
      const [oldest] = ofDwarf[0] as [MessageId, Watched]
      this.forget(oldest)
    }
    this.watched.set(messageId, watched)
  }

  /**
   * A dwarf's turn ended. A hand-over still in flight keeps it for its receipt. With work done the
   * dwarf's held messages are handed over (S7.04); an errored or interrupted turn leaves them held,
   * since 07 machine 7 lists no transition out of `sending` for it (S7.03). The message the turn
   * consumed is reacted to (S7.05). Never throws to the bus: `move` records its own failures.
   */
  private turnEnded(end: TurnEnded): void {
    for (const flight of this.inFlight.values()) {
      if (flight.dwarfId === end.dwarfId) flight.endsSeen.push(end)
    }
    const released = new Set<MessageId>()
    if (workDone(end)) {
      for (const [messageId, held] of [...this.held]) {
        if (held.dwarfId !== end.dwarfId) continue
        this.held.delete(messageId)
        released.add(messageId)
        this.accept(held.dwarfId, messageId, held.receipt, [end])
      }
    }
    for (const [messageId, watched] of [...this.watched]) {
      if (released.has(messageId)) continue
      if (watched.dwarfId !== end.dwarfId || watched.providerTurnId !== end.turnKey) continue
      if (workDone(end)) {
        this.move(messageId, { t: 'activity-correlated', reactionEvidence: 'turn-id' })
      }
      this.forget(messageId)
    }
  }

  /** Ends the Host-memory tracking of a message. */
  private forget(messageId: MessageId): void {
    this.deliveries.delete(messageId)
    this.inFlight.delete(messageId)
    this.held.delete(messageId)
    this.watched.delete(messageId)
  }

  /**
   * A write or publish of a delivery failed: its tracking ends. A row no longer there (the log's
   * `HostInvariantError`: trimmed after ✓, or deleted with its departed dwarf by Reset) ends it
   * quietly; any other failure is logged with allowlisted fields only (ADR-026), never the text.
   */
  private dropAfter(error: unknown, messageId: MessageId, dwarfId: DwarfId): void {
    this.forget(messageId)
    if (error instanceof HostInvariantError) return
    this.deps.diagnostics.record({
      level: 'error',
      event: 'message.delivery.record-failed',
      subsystem: 'conversation',
      outcome: 'failed',
      errCode: codeOf(error),
      dwarfId,
      messageId
    })
  }

  /**
   * One machine-7 step of `messageId`'s current delivery: stored, then published after the commit.
   * A step the machine refuses changes nothing. Returns whether it moved; never throws.
   */
  private move(messageId: MessageId, fact: DeliveryFact): boolean {
    const current = this.deliveries.get(messageId)
    if (current === undefined) return false
    const step = advance(current, fact, this.deps.clock.now())
    if (!step.ok) return false
    const next = step.delivery
    const { dwarfId } = next
    try {
      this.deps.transactions.inTransaction(() =>
        this.deps.log.settleDelivery(messageId, settlementOf(next), next.phaseAt)
      )
      this.deliveries.set(messageId, next)
      if (next.phase === 'failed' && next.failure !== undefined) {
        this.forget(messageId)
        this.publish('MessageDeliveryFailed', { messageId, dwarfId, failure: next.failure })
      } else if (fact.t === 'accepted') {
        // The receipt's own confidence: never one the Host assumed (FM-077).
        this.publish('MessageHandedOver', { messageId, dwarfId, confidence: fact.confidence })
      } else if (next.phase === 'reacted') {
        this.publish('MessageReactedTo', { messageId, dwarfId })
      }
      // S7.03 (still sending, now held) publishes nothing: 08 has no event for it, the mark stays
      // "…", and the snapshot `marks` section carries the stored hold.
      return true
    } catch (error) {
      this.dropAfter(error, messageId, dwarfId)
      return false
    }
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
