// The `driver` answer channel (05 §3.7: "`DriverAskChannel` bridge → suppliers `ProviderDriver`";
// 16 §4.7 `AskAnswerChannel`; ADR-010 items 1, 5, 8; ISSUE-182): the asking module's door to a
// launched session. An answer given in the app for an ask a driver opened (`ask.opened` with
// channel `driver`) is handed to that dwarf's own live `DriverSession` — `answerPermission`, or
// `answerQuestion` with the answers or the explicit decline (ADR-011 item 3) — and the session's
// `AnswerOutcome` comes back unchanged (the driver returns ADR-010's type as is).
//
// - The dwarf → session lookup is the composition root's: launching's live owned record and the
//   session suppliers holds for it (`ownedSessionsOver`, bridges/sessionTerminator.ts). A dwarf with
//   no live session answers `refused: 'channel-unavailable'`, so nothing is handed over (fail
//   closed; the broker bounds every call at 30 s itself, ADR-010 item 8).
// - `staleAnswerSafe` is true: a driver's late answer is refused by the session itself, with no
//   side effect (ADR-009 D2: false only for the keystroke channel, ADR-012).
import type { AnswerOutcome, QuestionAnswers } from '../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../kernel/domain/values'
import type { DriverSession } from '../../modules/suppliers'

/** The asking module's `AskAnswerChannel` shape (16 §4.7), with the channel's capability record. */
export interface DriverAskChannel {
  readonly capabilities: { readonly staleAnswerSafe: boolean }
  answerQuestion(
    ref: { dwarfId: DwarfId },
    providerRequestId: string,
    answers: QuestionAnswers
  ): Promise<AnswerOutcome>
  answerPermission(
    ref: { dwarfId: DwarfId },
    providerRequestId: string,
    decision: 'allow' | 'deny'
  ): Promise<AnswerOutcome>
  declineQuestion(ref: { dwarfId: DwarfId }, providerRequestId: string): Promise<AnswerOutcome>
}

export interface DriverAskChannelDeps {
  /** The dwarf's live driver session, or null when launching owns none for it now. */
  sessionOf(dwarfId: DwarfId): Pick<DriverSession, 'answerPermission' | 'answerQuestion'> | null
}

const UNAVAILABLE: AnswerOutcome = { kind: 'refused', reason: 'channel-unavailable' }

export function createDriverAskChannel(deps: DriverAskChannelDeps): DriverAskChannel {
  const toSession = (
    dwarfId: DwarfId,
    hand: (
      session: Pick<DriverSession, 'answerPermission' | 'answerQuestion'>
    ) => Promise<AnswerOutcome>
  ): Promise<AnswerOutcome> => {
    const session = deps.sessionOf(dwarfId)
    return session === null ? Promise.resolve(UNAVAILABLE) : hand(session)
  }
  return {
    capabilities: { staleAnswerSafe: true },
    answerPermission: (ref, providerRequestId, decision) =>
      toSession(ref.dwarfId, (session) =>
        session.answerPermission({ providerRequestId, decision })
      ),
    answerQuestion: (ref, providerRequestId, answers) =>
      toSession(ref.dwarfId, (session) => session.answerQuestion({ providerRequestId, answers })),
    declineQuestion: (ref, providerRequestId) =>
      toSession(ref.dwarfId, (session) =>
        session.answerQuestion({ providerRequestId, decline: true })
      )
  }
}
