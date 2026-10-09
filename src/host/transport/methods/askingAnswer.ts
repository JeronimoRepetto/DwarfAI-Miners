// B-M30 `asking.answerQuestion` and B-M31 `asking.answerPermission` (14 §2.3, §3.4
// `AnswerQuestionParams`, `AnswerPermissionParams`, frozen; ADR-010 items 2, 4, 5; ADR-003 items 6,
// 12): a person's answer to a dwarf's question or permission, handed to the ask broker's two answer
// paths. UI main's A-40 and A-41 relay them (ui-main/ipc/handlers/answerDwarf.host.ts, routed by the
// cut-2 switch, later: ISSUE-141). Nothing registers them yet: the composition root registers them
// over the asking module with the wiring (later: ISSUE-140, ISSUE-141).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6): the caller's `requestId` is the `ask_answers` primary key, a durable key
//   (dedupe/mutatingMethods.ts `DURABLE_KEY_METHODS`); on one connection a repeated `requestId`
//   gets the first answer from the dispatcher's table and the broker is called once (INV-79).
// - The params are the contract's strict() schemas (INVALID_PARAMS otherwise, before the handler
//   runs): a permission is Allow or Deny only, never broadened (INV-73); a question's answers are
//   `QuestionAnswers`.
// - Answered after it settled (14 §1.7): the broker's promise resolves once the channel result is
//   committed, and its ADR-010 `AnswerOutcome` is the result unchanged — `not-open` included, which
//   the renderer draws as nothing (14 §2.1 A-40).
// - B-M30's params are sensitive (14 §3.5 SENSITIVE_METHODS: free-text answers). The dispatcher
//   logs the method name, outcome and code only, and nothing here logs.
import { HOST_METHOD_SCHEMAS, type AnswerOutcome } from '@dwarfai/contracts'
import type { AskBroker } from '../../modules/asking'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface AskingAnswerDeps {
  broker: Pick<AskBroker, 'answerQuestion' | 'answerPermission'>
}

/** Serves `asking.answerQuestion` (B-M30) and `asking.answerPermission` (B-M31) on `dispatcher`. */
export function registerAskingAnswer(dispatcher: Dispatcher, deps: AskingAnswerDeps): void {
  dispatcher.registerMutating(
    'asking.answerQuestion',
    HOST_METHOD_SCHEMAS['asking.answerQuestion'].params,
    METHOD_ROLES['asking.answerQuestion'] ?? [],
    (params, context): Promise<AnswerOutcome> =>
      deps.broker.answerQuestion(params.askId, params.answers, context.requestId)
  )
  dispatcher.registerMutating(
    'asking.answerPermission',
    HOST_METHOD_SCHEMAS['asking.answerPermission'].params,
    METHOD_ROLES['asking.answerPermission'] ?? [],
    (params, context): Promise<AnswerOutcome> =>
      deps.broker.answerPermission(params.askId, params.decision, context.requestId)
  )
}
