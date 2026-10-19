// The AskAnswerChannel double (16 §4.7 doubles row: `FakeAskAnswerChannel`, scripted outcomes,
// delay). Never imported by production code (R14).
//
// - Every call is recorded in `calls`, in order, with its arguments.
// - Each call answers the next outcome given to `script`, and `accepted` once the script is spent.
// - While `hold` is on, the answers stay pending until `release()`: a test can read the state while
//   the hand-over is in flight, or let a fake clock pass the broker's 30 s bound (ADR-010 item 8).
import type { AnswerOutcome, QuestionAnswers } from '../../../../kernel/domain/sharedContracts'
import type { AskAnswerChannel } from '../askAnswerChannel'
import type { AskChannelRef } from '../askRepository'

export type FakeAskAnswerCall =
  | {
      method: 'answerQuestion'
      ref: AskChannelRef
      providerRequestId: string
      answers: QuestionAnswers
    }
  | {
      method: 'answerPermission'
      ref: AskChannelRef
      providerRequestId: string
      decision: 'allow' | 'deny'
    }
  | { method: 'declineQuestion'; ref: AskChannelRef; providerRequestId: string }

export class FakeAskAnswerChannel implements AskAnswerChannel {
  readonly calls: FakeAskAnswerCall[] = []
  /** On: answers wait for `release()`. */
  hold = false
  private readonly scripted: AnswerOutcome[] = []
  private readonly held: Array<() => void> = []

  /** Queues the outcomes of the next calls, in order. */
  script(...outcomes: AnswerOutcome[]): void {
    this.scripted.push(...outcomes)
  }

  /** Answers every held call, in order. */
  release(): void {
    for (const answer of this.held.splice(0)) answer()
  }

  answerQuestion(
    ref: AskChannelRef,
    providerRequestId: string,
    answers: QuestionAnswers
  ): Promise<AnswerOutcome> {
    return this.answer({ method: 'answerQuestion', ref, providerRequestId, answers })
  }

  answerPermission(
    ref: AskChannelRef,
    providerRequestId: string,
    decision: 'allow' | 'deny'
  ): Promise<AnswerOutcome> {
    return this.answer({ method: 'answerPermission', ref, providerRequestId, decision })
  }

  declineQuestion(ref: AskChannelRef, providerRequestId: string): Promise<AnswerOutcome> {
    return this.answer({ method: 'declineQuestion', ref, providerRequestId })
  }

  private answer(call: FakeAskAnswerCall): Promise<AnswerOutcome> {
    this.calls.push(call)
    const outcome = this.scripted.shift() ?? { kind: 'accepted' }
    if (!this.hold) return Promise.resolve(outcome)
    return new Promise((resolve) => this.held.push(() => resolve(outcome)))
  }
}
