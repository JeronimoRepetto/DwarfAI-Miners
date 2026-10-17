// B-M25 `conversation.retry` (14 §2.3, §3.4 `RetryMessageParams` / `RetryMessageResult`, frozen; 14
// §1.6, §1.7; ADR-022 item 5; ISSUE-168): Retry of a message that failed to deliver, as the same
// message, handed to the conversation module's `ConversationCommands.retry`. UI main's A-N06
// relays it (its route is the 3a switch's, ISSUE-001). The conversation wiring registers it
// (wiring/routes/conversation.ts).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6): one effect per `requestId` on a connection through the dispatcher's table
//   (16 §4.6 retry row: "requestId at transport"); `conversation.retry` is no durable-key method.
// - The params are the contract's strict() schema (ADR-019): an extra key is INVALID_PARAMS before
//   the handler runs.
// - Answered at acceptance (14 §1.7): `{}` once the message's delivery is `sending` again and
//   committed; `cannot-receive` / `not-failed` are outcomes, not errors, and change nothing. The
//   settlement arrives only as `message.delivery`.
import { HOST_METHOD_SCHEMAS, type RetryMessageResult } from '@dwarfai/contracts'
import type { ConversationCommands } from '../../modules/conversation'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface ConversationRetryDeps {
  conversation: Pick<ConversationCommands, 'retry'>
}

/** Serves `conversation.retry` (B-M25) on `dispatcher`. */
export function registerConversationRetry(
  dispatcher: Dispatcher,
  deps: ConversationRetryDeps
): void {
  dispatcher.registerMutating(
    'conversation.retry',
    HOST_METHOD_SCHEMAS['conversation.retry'].params,
    METHOD_ROLES['conversation.retry'] ?? [],
    async (params): Promise<RetryMessageResult> => {
      const retried = await deps.conversation.retry(params.messageId, params.requestId)
      return retried.ok ? { ok: true, value: {} } : retried
    }
  )
}
