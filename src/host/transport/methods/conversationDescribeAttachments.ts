// B-M28 `conversation.describeAttachments` (14 §2.3, §3.4, frozen; ADR-019 item 9; 16 §4.6;
// ISSUE-169): the Host's re-validation of the paths a UI picked or dropped, never trusted: one
// `AttachmentPick` per path, in the order asked, each accepted with its name and size or carrying
// its refusal (A-25's eA shape: `[]` + a per-item `refusal`). UI main's A-25 relays it (its route is
// ISSUE-001's). The conversation wiring registers it (wiring/routes/conversation.ts).
//
// - Roles (roles.ts): `ui` only; a `notifier` or a `viewer` gets FORBIDDEN before the handler runs.
// - A query: no requestId, no effect, no frame. The params are the contract's strict() schema
//   (INVALID_PARAMS otherwise, before the handler runs). No count limit (US-MSG-002.AC07).
// - Sensitive both ways (14 §3.5 SENSITIVE_METHODS: paths); nothing here logs.
import { HOST_METHOD_SCHEMAS, type AttachmentPick } from '@dwarfai/contracts'
import type { ConversationAttachmentCommand } from '../../modules/conversation'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface ConversationDescribeAttachmentsDeps {
  conversation: ConversationAttachmentCommand
}

/** Serves `conversation.describeAttachments` (B-M28) on `dispatcher`. */
export function registerConversationDescribeAttachments(
  dispatcher: Dispatcher,
  deps: ConversationDescribeAttachmentsDeps
): void {
  dispatcher.register(
    'conversation.describeAttachments',
    HOST_METHOD_SCHEMAS['conversation.describeAttachments'].params,
    METHOD_ROLES['conversation.describeAttachments'] ?? [],
    async (params): Promise<AttachmentPick[]> => {
      const picks = await deps.conversation.describeAttachments(params.paths)
      // The module's pick is the wire's (14 §8 I-10), field for field; nothing else is added.
      return picks.map(({ path, attachment, refusal, thumbnail }) => ({
        path,
        ...(attachment === undefined ? {} : { attachment: { ...attachment } }),
        ...(refusal === undefined ? {} : { refusal }),
        ...(thumbnail === undefined ? {} : { thumbnail })
      }))
    }
  )
}
