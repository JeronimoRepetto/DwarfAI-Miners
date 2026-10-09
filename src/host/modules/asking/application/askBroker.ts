// ADR-010's `AskBroker`, the asking module's driving port (05 §3.7). Its copy lives here rather than
// beside `AskRecord` in `domain/ask.ts` because it names suppliers' `AskInput` (15 §1.2), which a
// domain file cannot import (R1); application imports suppliers' index along the asking → suppliers
// edge (05 §1.3).
//
// ISSUE-128: `AskAnswerPaths`, the broker's two answer paths (ADR-010 items 2, 4, 5, 8, 13; 16 §4.7
// rows `answerPermission` / `answerQuestion`; 09 §8.2). `open`, `setStep`, `resolveExternally`,
// `closeForDwarf` and `snapshot` join with their issues (later: ISSUE-129, ISSUE-130, ISSUE-136,
// ISSUE-140).
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
import type { AnswerRecordEvent, AnswerRecords } from '../../conversation'
import type { AskInput } from '../../suppliers'
import {
  ANSWER_HANDOVER_TIMEOUT_MS,
  type Ask,
  type AskChannel,
  type AskRecord
} from '../domain/ask'
import { channelResult, submit as submitAsk } from '../domain/askMachine'
import { permissionRecordText, questionRecordText } from '../domain/answersRecordText'
import type { AskingEvent } from '../domain/events'
import type { AskAnswerChannel } from '../ports/askAnswerChannel'
import type { AskRepository } from '../ports/askRepository'

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

export class AskAnswerPaths implements Pick<AskBroker, 'answerPermission' | 'answerQuestion'> {
  /** The submits whose hand-over is in flight, by `requestId`. */
  private readonly inFlight = new Map<string, Promise<AnswerOutcome>>()

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
    this.deps.bus.publish(
      this.event('MessageSent', {
        messageId: won.messageId,
        dwarfId: won.ask.dwarfId as DwarfId,
        kind: 'answers-record'
      })
    )
    const settled = this.handOver(won.ask, submit)
      .then((result) => this.settle(won, requestId, result))
      .finally(() => this.inFlight.delete(requestId))
    this.inFlight.set(requestId, settled)
    return settled
  }

  /** Transaction 1 (09 §8.2): the winner, or the outcome to answer with nothing written. */
  private critical(askId: AskId, requestId: string, submit: Submit): Won | AnswerOutcome {
    const { asks, records } = this.deps
    const first = asks.answerOf(requestId)
    if (first !== null) return first.outcome ?? NOT_OPEN
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

  /** Transaction 2: the result on the ask as it now stands, then its events. */
  private settle(won: Won, requestId: string, result: AnswerOutcome): AnswerOutcome {
    const { asks, records, transactions, clock, bus } = this.deps
    const askId = won.ask.id as AskId
    const dwarfId = won.ask.dwarfId as DwarfId
    const { step, outcome } = transactions.inTransaction(() => {
      const current = asks.byId(askId) ?? won.ask
      const settled = channelResult(current, result, clock.now())
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
    if (step.transition === 'S6.08' || step.transition === 'S6.10') {
      bus.publish(this.event('AskClosed', { askId, dwarfId, reason: step.ask.state }))
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
