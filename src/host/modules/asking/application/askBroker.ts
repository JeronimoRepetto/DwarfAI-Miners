// ADR-010's `AskBroker`, the asking module's driving port (05 §3.7). Its copy lives here rather than
// beside `AskRecord` in `domain/ask.ts` because it names suppliers' `AskInput` (15 §1.2), which a
// domain file cannot import (R1); application imports suppliers' index along the asking → suppliers
// edge (05 §1.3). The implementation lands with the broker (later: ISSUE-128).
import type { AnswerOutcome, QuestionAnswers } from '../../../kernel/domain/sharedContracts'
import type { AskInput } from '../../suppliers'
import type { AskRecord } from '../domain/ask'

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
