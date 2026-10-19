// ADR-010's `AskBroker`, the asking module's driving port (05 §3.7). Its copy lives here rather than
// beside `AskRecord` in `domain/ask.ts` because it names suppliers' `AskInput` (15 §1.2), which a
// domain file cannot import (R1); application imports suppliers' index along the asking → suppliers
// edge (05 §1.3).
//
// ISSUE-128: `AskAnswerPaths`, the broker's two answer paths (ADR-010 items 2, 4, 5, 8, 13; 16 §4.7
// rows `answerPermission` / `answerQuestion`; 09 §8.2). `snapshot` is the `AskQueries` read model
// (ISSUE-130, `askQueries.ts`).
//
// ISSUE-140: `closeForDwarf` (16 §4.7 row `closeForDwarf`; 07 S6.14, S6.15; INV-77), routed from
// `DwarfDeparted`: one transaction closes every `open` or `answering` ask of the dwarf
// `closed-by-death`, then `AskClosed` per ask, front first, and nothing else. An answer in flight
// then settles `ask-closed` with no card back (S6.15), as after a cancellation (S6.22).
//
// ISSUE-132: `open` (`AskOpenPath`, 16 §4.7 row `open`), with ADR-011 item 5's emission resolved
// from the session's capabilities as data (`domain/emission.ts`, `SessionCapabilities`), never a
// provider name (R12):
// - `card` (S6.01) and `channel-none` (S6.02, INV-76: every submit `not-open`) save an `open` ask
//   and publish `AskOpened` after the commit; the FIFO front is the repository's (INV-70).
// - `auto-denied` (S6.03): the ask is born closed, and conversation's `ingest` writes the one
//   `system-line` in the same transaction; after the commit `AskClosed{auto-denied}` and the line's
//   `MessagesAppended`, never `AskOpened` (07 S1.16); then the channel's Deny, or `declineQuestion`
//   for a question, outside any transaction.
// - `not-an-ask` (S1.17): the caller reported a kind the session cannot detect; nothing is written
//   and the call is refused as a programming error (the observer opens nothing then, UC-016 B).
// - The same `(dwarfId, providerRequestId)` again returns the first record and does nothing (INV-71).
//
// ISSUE-129: `setStep` (`AskStepPath`, 16 §4.7 row `setStep`; 07 S6.04; INV-75): one transaction
// saves the front open ask's new `currentStep`, and `AskStepChanged` follows the commit; anything
// else is a silent no-op. The picks never reach the Host (OQ-03): they stay in UI main's session
// store (14 §3.9 `ask-picks`).
//
// ISSUE-131: `resolveExternally` for an ask whose answer is in flight — the S6.21 hold of an
// `elsewhere` resolution until the channel result, and the S6.22 close of a cancellation, after
// which the result settles as `ask-closed` with no card back. The hold lives in this instance only:
// an ask still `answering` after a Host restart has no call in flight here and is settled by the
// boot reconcile (07 S6.20).
//
// ISSUE-134: the `open` branch of `resolveExternally` (S6.11, S6.12, S6.13) with ADR-010 item 10's
// attribution, and ADR-012 item 3's late-Deny status line (`domain/attribution.ts`):
// - Handing a decision to a channel whose resolution evidence cannot tell who answered (the
//   keystroke channel) records `{askId, injectedAt, decision}`, `injectedAt` being the hand-over's
//   start, so the window never reaches past the keys. An `elsewhere` resolution of the ask while it
//   is `open` (after a refusal: the relay failed or timed out and the keys may have landed, S6.09)
//   within 10 s of that injection closes it answered in the app (S6.12); any other closes it
//   answered elsewhere with no notice (S6.11). The record lives in this instance only, like the
//   hold: after a Host restart a resolution is answered elsewhere, the side that never claims an
//   answer the app cannot prove.
// - A Deny closed in the app through a channel that is not stale-answer safe (the composed channel's
//   capability record, `staleAnswerSafe`) carries the late-Deny status line on its `AskClosed`.
// Package gap (resolved here): ISSUE-136 owns the other channels' resolution signals and the
// generic route; the branch itself is channel-blind, so S6.11 and S6.13 apply to every channel.
//
// - A repeated `requestId` returns the first result and does nothing again (INV-79): while it is in
//   flight, the same promise; once settled, `ask_answers.outcome` (`AskRepository.answerOf`), which
//   survives a Host restart (14 §1.6).
// - Transaction 1, the critical section (ADR-010 item 4, INV-72): read the ask; a submit that does
//   not win (an unknown or closed ask, a queued one, one of the other kind, one with no answer
//   channel, INV-76) returns `not-open` with nothing written (S6.07). The winner moves the ask to
//   `answering` with its pending `ask_answers` row (`settle`), writes the "Answers:" record with its
//   delivery `sending` through conversation's `AnswerRecords` (a new one, or the ask's earlier
//   record updated in place, `recordOf`, ADR-010 item 13) and links it (`linkRecord`). All of it
//   commits or rolls back together; `MessageSent` follows the commit.
// - The hand-over runs outside any transaction (record before acting, 09 §8.2): the ask's channel,
//   bounded at 30 s (`ANSWER_HANDOVER_TIMEOUT_MS`, INV-74) → `refused: 'channel-unavailable'`, as is
//   a channel that throws or is not composed. A late answer after the bound changes nothing.
// - Transaction 2: machine 6 settles the result on the ask as it now stands (`channelResult`:
//   S6.08 accepted, S6.09 reopened, S6.10 answered elsewhere, or an ask closed meanwhile that stays
//   closed, S6.15/S6.22), records the outcome (`settleAnswer`) and the record's delivery
//   (`AnswerRecords.settle`). Then `AskClosed` + `MessageHandedOver`, or `AskReopened` +
//   `MessageDeliveryFailed`, or (`AskClosed` +) `MessageDeliveryFailed {ask-closed}` (16 §4.7).
// - The answer is the settled `AnswerOutcome` (14 §1.7: answered after the channel result).
//
// Package gaps (resolved here): an answer of the other kind (a decision on a question, answers on a
// permission) cannot come from the card; it is a submit that does not win (`not-open`, nothing
// written). A repeated `requestId` whose first submit was still in flight when the Host stopped
// finds no outcome to return: the boot reconcile settles that ask (07 S6.20, later work) and the
// repeat answers `not-open`, which renders nothing.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type {
  AnswerOutcome,
  PermissionPayload,
  QuestionAnswers,
  QuestionPayload
} from '../../../kernel/domain/sharedContracts'
import type { AskId, DwarfId, EventId, HostEpoch, MessageId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type {
  AnswerRecordEvent,
  AnswerRecords,
  ConversationCommands,
  JoinedEvents
} from '../../conversation'
import type { AskInput } from '../../suppliers'
import {
  ANSWER_HANDOVER_TIMEOUT_MS,
  type Ask,
  type AskChannel,
  type AskRecord
} from '../domain/ask'
import {
  autoDenyAsk,
  channelResult,
  closeForDwarf as closeDwarfAsks,
  openAsk,
  resolveExternally as resolveAsk,
  setStep as stepAsk,
  type AskOpening,
  submit as submitAsk
} from '../domain/askMachine'
import { permissionRecordText, questionRecordText } from '../domain/answersRecordText'
import {
  answeredInAppBy,
  attributesByInjection,
  lateDenyStatusLine,
  type Injection
} from '../domain/attribution'
import { AUTO_DENIED_LINE_TEXT, resolveEmission, type Emission } from '../domain/emission'
import type { AskClosed, AskingEvent } from '../domain/events'
import type { PermissionDecision } from '../domain/permissionOptions'
import type { AskAnswerChannel } from '../ports/askAnswerChannel'
import type { AskRepository } from '../ports/askRepository'
import type { SessionCapabilities } from '../ports/sessionCapabilities'

// verbatim: ADR-010 item 5 (`AskBroker`, byte-for-byte with the list indentation removed; `prettier-ignore` keeps its alignment)
// prettier-ignore
export interface AskBroker {
  open(dwarfId: string, input: AskInput): AskRecord
                                                  // from drivers / ingress; idempotent by (dwarfId, input.providerRequestId);
                                                  // the caller (suppliers, observation, hook/plugin ingress) resolves
                                                  // SessionRef → dwarfId before calling (08 §4); AskInput: 15 §1.2
  setStep(askId: string, step: number): void      // UI → Host while the person walks steps
  answerPermission(askId: string, decision: 'allow' | 'deny', requestId: string): Promise<AnswerOutcome>
  answerQuestion(askId: string, answers: QuestionAnswers, requestId: string): Promise<AnswerOutcome>
  resolveExternally(dwarfId: string, providerRequestId: string, by: 'elsewhere' | 'cancelled'): void
  closeForDwarf(dwarfId: string): void            // session ended → closed-by-death
  snapshot(): AskRecord[]                         // open asks for hello/snapshot (A8)
}
// end verbatim: ADR-010 item 5

export interface AnswerPathsDeps {
  asks: AskRepository
  /** conversation's `AnswerRecords` (16 §4.6): joins this module's transactions. */
  records: AnswerRecords
  /** The answer channel of an ask's `channel` kind, or null when none is composed. */
  channelFor(channel: AskChannel): AskAnswerChannel | null
  /**
   * The composed channel's ADR-009 D2 `staleAnswerSafe`: false only for the keystroke channel
   * (ADR-012 item 3), whose late Deny can interrupt a turn.
   */
  staleAnswerSafe(channel: AskChannel): boolean
  transactions: TransactionRunner
  /** Publishes after each commit (16 §2.3). */
  bus: DomainEventBus<AskingEvent | AnswerRecordEvent>
  clock: Clock
  /** Bounds the hand-over (16 §2.6). */
  scheduler: Scheduler
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
}

type Submit =
  | { kind: 'permission'; decision: 'allow' | 'deny' }
  | { kind: 'question'; answers: QuestionAnswers }

/** The critical section's winner: the ask now `answering` and its record. */
interface Won {
  ask: Ask
  messageId: MessageId
}

const NOT_OPEN: AnswerOutcome = { kind: 'not-open' }
const UNAVAILABLE: AnswerOutcome = { kind: 'refused', reason: 'channel-unavailable' }

export class AskAnswerPaths implements Pick<
  AskBroker,
  'answerPermission' | 'answerQuestion' | 'resolveExternally' | 'closeForDwarf'
> {
  /** The submits whose hand-over is in flight, by `requestId`. */
  private readonly inFlight = new Map<string, Promise<AnswerOutcome>>()
  /** The asks resolved elsewhere while their answer is in flight, held for its result (S6.21). */
  private readonly held = new Set<AskId>()
  /** The decisions handed to an attributed channel, by ask (ADR-010 item 10). */
  private readonly injections = new Map<AskId, Injection>()

  constructor(private readonly deps: AnswerPathsDeps) {}

  answerPermission(
    askId: string,
    decision: 'allow' | 'deny',
    requestId: string
  ): Promise<AnswerOutcome> {
    return this.answer(askId as AskId, requestId, { kind: 'permission', decision })
  }

  answerQuestion(
    askId: string,
    answers: QuestionAnswers,
    requestId: string
  ): Promise<AnswerOutcome> {
    return this.answer(askId as AskId, requestId, { kind: 'question', answers })
  }

  /**
   * An external resolution (07 §6). An `open` ask closes now: `elsewhere` answered elsewhere with no
   * notice (S6.11), or answered in the app when the attribution window gives it to DwarfAI's
   * injection (S6.12); `cancelled` cancelled (S6.13). An ask whose answer is in flight: `elsewhere`
   * is held until the channel call returns and settled with its result (S6.21); `cancelled` closes
   * it now (S6.22) and the result then settles as `ask-closed`. A closed ask changes nothing.
   */
  resolveExternally(
    dwarfId: string,
    providerRequestId: string,
    by: 'elsewhere' | 'cancelled'
  ): void {
    const { asks, transactions, clock, bus } = this.deps
    const closed = transactions.inTransaction((): Ask | null => {
      const ask = asks.byProviderRequest({ dwarfId: dwarfId as DwarfId }, providerRequestId)
      if (ask === null || (ask.state !== 'open' && ask.state !== 'answering')) return null
      const now = clock.now()
      // Only an attributed channel's hand-over is ever recorded (`answer`).
      const injectedInApp = answeredInAppBy(this.injections.get(ask.id as AskId), now)
      const step = resolveAsk(ask, by, now, injectedInApp)
      if (step.held !== null) {
        this.held.add(ask.id as AskId)
        return null
      }
      asks.save(step.ask)
      return step.ask
    })
    if (closed === null) return
    const injection = this.injections.get(closed.id as AskId)
    this.injections.delete(closed.id as AskId)
    bus.publish(this.closedEvent(closed, injection?.decision ?? null))
  }

  /** Closing by death (S6.14, S6.15): every live ask of the dwarf, oldest first; once. */
  closeForDwarf(dwarfId: string): void {
    const { asks, transactions, clock, bus } = this.deps
    const closed = transactions.inTransaction((): Ask[] => {
      const steps = closeDwarfAsks(asks.live(), dwarfId, clock.now())
      const moved = steps.filter((step) => step.transition !== null).map((step) => step.ask)
      for (const ask of moved) asks.save(ask)
      return moved
    })
    for (const ask of closed) {
      // Nothing more to attribute or hold: the result of an answer in flight settles `ask-closed`.
      this.injections.delete(ask.id as AskId)
      this.held.delete(ask.id as AskId)
      bus.publish(this.closedEvent(ask, null))
    }
  }

  private answer(askId: AskId, requestId: string, submit: Submit): Promise<AnswerOutcome> {
    const pending = this.inFlight.get(requestId)
    if (pending !== undefined) return pending
    let decided: Won | AnswerOutcome
    try {
      // Synchronous up to the commit: a second submit sees this one's `answering` (INV-72).
      decided = this.deps.transactions.inTransaction(() => this.critical(askId, requestId, submit))
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    if ('kind' in decided) return Promise.resolve(decided)
    const won = decided
    if (submit.kind === 'permission' && attributesByInjection(won.ask.channel)) {
      this.injections.set(won.ask.id as AskId, {
        injectedAt: this.deps.clock.now(),
        decision: submit.decision
      })
    }
    const settled = this.handOver(won.ask, submit)
      .then((result) => this.settle(won, requestId, submit, result))
      .finally(() => this.inFlight.delete(requestId))
    // In flight before any subscriber runs: a re-submit of this requestId from a `MessageSent`
    // handler gets this same answer (INV-79).
    this.inFlight.set(requestId, settled)
    this.deps.bus.publish(
      this.event('MessageSent', {
        messageId: won.messageId,
        dwarfId: won.ask.dwarfId as DwarfId,
        kind: 'answers-record'
      })
    )
    return settled
  }

  /** Transaction 1 (09 §8.2): the winner, or the outcome to answer with nothing written. */
  private critical(askId: AskId, requestId: string, submit: Submit): Won | AnswerOutcome {
    const { asks, records } = this.deps
    const first = asks.answerOf(requestId)
    // A requestId names one submit of one ask: reused for another ask, it wins nothing.
    if (first !== null) return first.askId === askId ? (first.outcome ?? NOT_OPEN) : NOT_OPEN
    const ask = asks.byId(askId)
    if (ask === null || ask.kind !== submit.kind) return NOT_OPEN
    const front = asks.openFor(ask.dwarfId as DwarfId)
    const decision = submitAsk(front === null || front.id === ask.id ? [ask] : [front, ask], askId)
    if (decision.kind !== 'won') return NOT_OPEN
    if (asks.settle(askId, { requestId }) !== 'settled') return NOT_OPEN
    const existing = asks.recordOf(askId)
    const messageId = records.write(
      ask.dwarfId as DwarfId,
      askId,
      recordText(ask, submit),
      existing ?? undefined
    )
    asks.linkRecord(requestId, messageId)
    return { ask: decision.ask, messageId }
  }

  /** The hand-over, outside any transaction, bounded at 30 s (ADR-010 item 8, INV-74). */
  private handOver(ask: Ask, submit: Submit): Promise<AnswerOutcome> {
    const channel = this.deps.channelFor(ask.channel)
    if (channel === null) return Promise.resolve(UNAVAILABLE)
    const ref = { dwarfId: ask.dwarfId as DwarfId }
    return new Promise((resolve) => {
      let done = false
      const timer = this.deps.scheduler.after(ANSWER_HANDOVER_TIMEOUT_MS, () => finish(UNAVAILABLE))
      function finish(outcome: AnswerOutcome): void {
        if (done) return
        done = true
        timer.cancel()
        resolve(outcome)
      }
      try {
        const call =
          submit.kind === 'permission'
            ? channel.answerPermission(ref, ask.providerRequestId, submit.decision)
            : channel.answerQuestion(ref, ask.providerRequestId, submit.answers)
        call.then(finish, () => finish(UNAVAILABLE))
      } catch {
        finish(UNAVAILABLE)
      }
    })
  }

  /**
   * Transaction 2: the result on the ask as it now stands, then its events.
   *
   * If this transaction throws, nothing of it is kept: the ask stays `answering` and its record
   * `sending` until the Host's boot reconcile settles them (07 S6.20 for the ask, S7.13 for the
   * record's delivery).
   *
   * An `elsewhere` resolution held while the call was in flight (S6.21) is passed to
   * `channelResult` and released once this transaction commits, so it is applied exactly once.
   */
  private settle(
    won: Won,
    requestId: string,
    submit: Submit,
    result: AnswerOutcome
  ): AnswerOutcome {
    const { asks, records, transactions, clock, bus } = this.deps
    const askId = won.ask.id as AskId
    const dwarfId = won.ask.dwarfId as DwarfId
    const held = this.held.has(askId) ? 'elsewhere' : null
    const { step, outcome } = transactions.inTransaction(() => {
      const current = asks.byId(askId) ?? won.ask
      const settled = channelResult(current, result, clock.now(), held)
      if (settled.transition !== null) asks.save(settled.ask)
      const final = settled.outcome
      if (final.kind === 'not-open') {
        throw new HostInvariantError('a settled hand-over is accepted or refused (ADR-010 item 5)')
      }
      asks.settleAnswer(requestId, final)
      records.settle(
        won.messageId,
        final.kind === 'accepted'
          ? { phase: 'delivered' }
          : { phase: 'failed', failure: { kind: 'refused', reason: final.reason } }
      )
      return { step: settled, outcome: final }
    })
    this.held.delete(askId)
    if (step.transition === 'S6.08' || step.transition === 'S6.10') {
      this.injections.delete(askId)
      bus.publish(
        this.closedEvent(
          step.ask,
          step.transition === 'S6.08' && submit.kind === 'permission' ? submit.decision : null
        )
      )
    }
    if (outcome.kind === 'refused' && step.transition === 'S6.09') {
      bus.publish(this.event('AskReopened', { askId, dwarfId, refusal: outcome.reason }))
    }
    bus.publish(
      outcome.kind === 'accepted'
        ? this.event('MessageHandedOver', {
            messageId: won.messageId,
            dwarfId,
            confidence: 'confirmed'
          })
        : this.event('MessageDeliveryFailed', {
            messageId: won.messageId,
            dwarfId,
            failure: { kind: 'refused', reason: outcome.reason }
          })
    )
    return outcome
  }

  /**
   * `AskClosed` for a closed ask; a Deny it was closed in the app by (S6.08, S6.12) carries the
   * late-Deny status line when its channel is not stale-answer safe (ADR-012 item 3).
   */
  private closedEvent(ask: Ask, decision: PermissionDecision | null): AskClosed {
    const statusLine =
      decision !== null && ask.state === 'answered-in-app'
        ? lateDenyStatusLine(decision, this.deps.staleAnswerSafe(ask.channel))
        : null
    return this.event('AskClosed', {
      askId: ask.id as AskId,
      dwarfId: ask.dwarfId as DwarfId,
      reason: ask.state,
      ...(statusLine === null ? {} : { statusLine })
    })
  }

  private event<T extends (AskingEvent | AnswerRecordEvent)['type']>(
    type: T,
    payload: Extract<AskingEvent | AnswerRecordEvent, { type: T }>['payload']
  ): Extract<AskingEvent | AnswerRecordEvent, { type: T }> {
    const { ids, clock, hostEpoch } = this.deps
    return {
      type,
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload
    } as Extract<AskingEvent | AnswerRecordEvent, { type: T }>
  }
}

/** The "Answers:" record text of a submit (domain/answersRecordText.ts). */
function recordText(ask: Ask, submit: Submit): string {
  return submit.kind === 'permission'
    ? permissionRecordText(ask.payload as PermissionPayload, submit.decision)
    : questionRecordText(ask.payload as QuestionPayload, submit.answers)
}

export interface OpenPathDeps {
  asks: AskRepository
  /** The dwarf's session origin and capabilities (ADR-011 item 5). */
  sessions: SessionCapabilities
  /** conversation's `ingest`: the auto-denied system line joins this module's transaction. */
  lines: Pick<ConversationCommands, 'ingest'>
  /** conversation's events held by that joined ingest, published after the commit (16 §2.3). */
  joinedLines: JoinedEvents
  /** The answer channel of an ask's `channel` kind, or null when none is composed. */
  channelFor(channel: AskChannel): AskAnswerChannel | null
  transactions: TransactionRunner
  /** Publishes after each commit (16 §2.3). */
  bus: DomainEventBus<AskingEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
}

/** What one `open` committed: the ask, and whether this call created it. */
interface Opening {
  ask: Ask
  created: boolean
  emission: Emission
}

export class AskOpenPath implements Pick<AskBroker, 'open'> {
  constructor(private readonly deps: OpenPathDeps) {}

  /**
   * 16 §4.7 row `open`. One transaction writes the ask (and, for an auto-denied request, its
   * system line through conversation); the events follow the commit; an auto-denied request is
   * answered through its channel last, outside any transaction (record before acting, 09 §8.2).
   */
  open(dwarfId: string, input: AskInput): AskRecord {
    const { sessions, transactions, joinedLines } = this.deps
    const session = sessions.sessionOf(dwarfId as DwarfId)
    const emission = resolveEmission(input, { origin: session.origin, ...session.capabilities })
    if (emission.kind === 'not-an-ask') {
      throw new HostInvariantError(
        'an observed request of a kind the provider cannot detect is not an ask (07 S1.17)'
      )
    }
    let opening: Opening
    try {
      opening = transactions.inTransaction(() => this.write(dwarfId as DwarfId, input, emission))
    } catch (error) {
      joinedLines.discard()
      throw error
    }
    if (opening.created) this.announce(opening)
    return opening.ask
  }

  /** Inside the transaction: the existing ask of the request (INV-71), or the new one. */
  private write(dwarfId: DwarfId, input: AskInput, emission: Emission): Opening {
    const { asks, lines, clock, ids } = this.deps
    const existing = asks.byProviderRequest({ dwarfId }, input.providerRequestId)
    if (existing !== null) return { ask: existing, created: false, emission }
    const opening: AskOpening = {
      id: ids.uuidv7(),
      dwarfId,
      kind: input.kind,
      channel: emission.kind === 'channel-none' ? 'none' : input.channel,
      providerRequestId: input.providerRequestId,
      payload: input.payload,
      options: input.kind === 'permission' ? input.options : null,
      reannounce: true
    }
    const now = clock.now()
    if (emission.kind === 'auto-denied') {
      const { ask } = autoDenyAsk(opening, now)
      asks.save(ask)
      lines.ingest(
        dwarfId,
        [
          {
            sourceKey: autoDeniedLineKey(ask.id),
            role: 'system-line',
            text: AUTO_DENIED_LINE_TEXT,
            providerTime: null
          }
        ],
        'live-stream'
      )
      return { ask, created: true, emission }
    }
    const opened = openAsk(opening, now)
    if (opened.kind !== 'opened') {
      throw new HostInvariantError('a card or channel-none emission always opens (ADR-011 item 5)')
    }
    asks.save(opened.ask)
    return { ask: opened.ask, created: true, emission }
  }

  /** After the commit: the events, then the auto-denied request's answer to the provider. */
  private announce({ ask, emission }: Opening): void {
    const { bus, joinedLines } = this.deps
    if (emission.kind !== 'auto-denied') {
      bus.publish(this.event('AskOpened', { ask }))
      return
    }
    // Never `AskOpened`: no card, no cue, no notification, the dwarf never asking (07 S1.16).
    bus.publish(
      this.event('AskClosed', {
        askId: ask.id as AskId,
        dwarfId: ask.dwarfId as DwarfId,
        reason: 'auto-denied'
      })
    )
    joinedLines.publish()
    this.refuse(ask, emission.answer)
  }

  /**
   * Deny for a permission, the explicit decline for a question (ADR-011 item 3, 16 §4.7
   * `declineQuestion`). The ask is closed already: whatever the channel answers changes nothing,
   * and a channel that is not composed or fails leaves the provider to its own launch policy.
   */
  private refuse(ask: Ask, answer: 'deny' | 'decline'): void {
    const channel = this.deps.channelFor(ask.channel)
    if (channel === null) return
    const ref = { dwarfId: ask.dwarfId as DwarfId }
    try {
      const call =
        answer === 'deny'
          ? channel.answerPermission(ref, ask.providerRequestId, 'deny')
          : channel.declineQuestion(ref, ask.providerRequestId)
      call.catch(() => undefined)
    } catch {
      // A channel that throws is the same as one that refuses: the ask stays auto-denied.
    }
  }

  private event<T extends AskingEvent['type']>(
    type: T,
    payload: Extract<AskingEvent, { type: T }>['payload']
  ): Extract<AskingEvent, { type: T }> {
    const { ids, clock, hostEpoch } = this.deps
    return {
      type,
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload
    } as Extract<AskingEvent, { type: T }>
  }
}

/** The system line's `sourceKey`: one line per auto-denied ask, claimed once (ADR-006). */
function autoDeniedLineKey(askId: string): string {
  return `ask:${askId}:auto-denied`
}

export interface StepPathDeps {
  asks: AskRepository
  transactions: TransactionRunner
  /** Publishes after each commit (16 §2.3). */
  bus: DomainEventBus<AskingEvent>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch. */
  hostEpoch: HostEpoch
}

export class AskStepPath implements Pick<AskBroker, 'setStep'> {
  constructor(private readonly deps: StepPathDeps) {}

  /**
   * 16 §4.7 row `setStep` (07 S6.04; INV-75). One transaction reads the ask and its dwarf's front
   * ask and, when the front open ask moves to another step, saves its `currentStep`;
   * `AskStepChanged` follows the commit. An unknown, closed or non-front `askId`, or the same step,
   * is a silent no-op: nothing written, no event, and never a throw for a UI-supplied id (16 §2.1).
   */
  setStep(askId: string, step: number): void {
    const { asks, transactions, bus, clock, ids, hostEpoch } = this.deps
    const moved = transactions.inTransaction((): Ask | null => {
      const ask = asks.byId(askId as AskId)
      if (ask === null) return null
      const front = asks.openFor(ask.dwarfId as DwarfId)
      const next = stepAsk(
        front === null || front.id === ask.id ? [ask] : [front, ask],
        askId,
        step
      )
      if (next === null) return null
      asks.save(next.ask)
      return next.ask
    })
    if (moved === null) return
    bus.publish({
      type: 'AskStepChanged',
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload: { askId: moved.id as AskId, currentStep: moved.currentStep }
    })
  }
}
