// Driven port (05 §3.7, 16 §4.7): how an answer reaches the provider, one per ADR-010
// `AskRecord.channel` kind (`driver`, `hook-keystroke`, `hook-decision`, `http`). Type-only (05 R2).
// Each returns ADR-010's `AnswerOutcome` unchanged from the provider; the broker bounds the call at
// 30 s (`ANSWER_HANDOVER_TIMEOUT_MS` → `refused: 'channel-unavailable'`, ADR-010 item 8). The
// concrete channels land with their providers (later: ISSUE-134/135, EPIC-10, ISSUE-229);
// `FakeAskAnswerChannel` is the double.
import type { AnswerOutcome, QuestionAnswers } from '../../../kernel/domain/sharedContracts'
import type { AskChannelRef } from './askRepository'

// verbatim: 05-modules-and-ports.md L910-L914 (16 §4.7; `prettier-ignore` keeps its alignment)
// prettier-ignore
export interface AskAnswerChannel {                  // one per ADR-010 AskRecord.channel kind
  answerQuestion(ref: AskChannelRef, providerRequestId: string, answers: QuestionAnswers): Promise<AnswerOutcome>      // ADR-010 item 5 type
  answerPermission(ref: AskChannelRef, providerRequestId: string, decision: 'allow' | 'deny'): Promise<AnswerOutcome>
  declineQuestion(ref: AskChannelRef, providerRequestId: string): Promise<AnswerOutcome>   // ADR-009 D3 explicit decline: auto-denied questions (ADR-011 item 3), secret inputs never rendered
}
// end verbatim
