// B-M24 `conversation.send` (14 §2.3, §3.4 `SendMessageParams` / `SendMessageResult`, frozen; 14
// §1.6, §1.7; ADR-022; ISSUE-166): a person's message to a dwarf as a Host command, handed to the
// conversation module's `ConversationCommands.send`. UI main's A-23 relays it (its route is
// ISSUE-001's). The conversation wiring registers it (wiring/routes/conversation.ts).
//
// - Roles (roles.ts): `ui` only; a `notifier` or `viewer` gets FORBIDDEN before the handler runs.
// - Mutating (14 §1.6): one effect per `requestId` on a connection through the dispatcher's table,
//   and, because `conversation.send` is a durable-key method, also across a Host restart: the
//   module stores it as `messages.request_id` (UNIQUE) and a repeat answers the stored `messageId`
//   with nothing handed over.
// - The params are the contract's strict() schema (ADR-019): an extra key is INVALID_PARAMS before
//   the handler runs. A `requestId` already stored for another dwarf is INVALID_PARAMS too (B-M24
//   errors eB): it never answers that dwarf's `messageId`.
// - Answered at acceptance (14 §1.7): `{ messageId }` once the row and its `sending` mark are
//   committed and their frames enqueued; `cannot-receive` / `attachment-refused` are outcomes, not
//   errors, and leave no row. The settlement arrives only as `message.delivery`.
// - The params are sensitive (14 §3.5 SENSITIVE_METHODS: the text); nothing here logs.
import { HOST_METHOD_SCHEMAS, type SendMessageResult } from '@dwarfai/contracts'
import { RequestIdOfAnotherDwarfError, type ConversationCommands } from '../../modules/conversation'
import { CallError, type Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface ConversationSendDeps {
  conversation: Pick<ConversationCommands, 'send'>
}

/** Serves `conversation.send` (B-M24) on `dispatcher`. */
export function registerConversationSend(dispatcher: Dispatcher, deps: ConversationSendDeps): void {
  dispatcher.registerMutating(
    'conversation.send',
    HOST_METHOD_SCHEMAS['conversation.send'].params,
    METHOD_ROLES['conversation.send'] ?? [],
    async (params): Promise<SendMessageResult> => {
      const { dwarfId, text, attachments, requestId } = params
      let sent: Awaited<ReturnType<ConversationCommands['send']>>
      try {
        sent = await deps.conversation.send(dwarfId, text, attachments, requestId)
      } catch (error) {
        // A requestId already stored for another dwarf is a malformed request (eB INVALID_PARAMS).
        if (error instanceof RequestIdOfAnotherDwarfError) throw new CallError('INVALID_PARAMS')
        throw error
      }
      return sent.ok ? { ok: true, value: { messageId: sent.value } } : sent
    }
  )
}
