// B-M26 `conversation.feed` (14 §2.3, §3.4 `FeedParams`, §3.6 `FeedPage`, frozen; ADR-003 item 12;
// ADR-007 item 6; ADR-031 item 2): one page of a dwarf's feed from the Host's message log, newest
// first, at most 50 rows (INV-61). A reopened chat paints from the snapshot's `tails` and pages the
// rest from here: nothing waits for a provider read (ADR-007 item 6). The composition root registers
// it over the conversation module (later: ISSUE-108); UI main's A-15 relays it
// (ui-main/ipc/handlers/getDwarfFeedPage.host.ts, routed by ISSUE-123).
//
// - Roles (roles.ts): `ui` pages any dwarf; a `viewer` pages only the dwarf its per-view token is
//   bound to (RequestContext.dwarfId) and gets FORBIDDEN for any other, before the module is read;
//   a `notifier` gets FORBIDDEN before the handler runs.
// - A query: no requestId, no effect, no frame. The params are the contract's strict() schema
//   (INVALID_PARAMS otherwise, before the handler runs): `limit` at most 50, `before` a MessageId.
// - The result is sensitive (14 §3.5 SENSITIVE_METHODS `'result'`): message text. The dispatcher
//   logs the method name, outcome and code only, and nothing here logs.
import { HOST_METHOD_SCHEMAS, type FeedPage } from '@dwarfai/contracts'
import type { DwarfId, MessageId } from '../../kernel/domain/values'
import type { ConversationQueries } from '../../modules/conversation'
import { CallError, type Dispatcher } from '../dispatcher'
import { toMessageWire } from '../mappers/wire'
import { METHOD_ROLES } from '../roles'

export interface ConversationFeedDeps {
  conversation: Pick<ConversationQueries, 'feed'>
}

/** Serves `conversation.feed` (B-M26) on `dispatcher`. */
export function registerConversationFeed(dispatcher: Dispatcher, deps: ConversationFeedDeps): void {
  dispatcher.register(
    'conversation.feed',
    HOST_METHOD_SCHEMAS['conversation.feed'].params,
    METHOD_ROLES['conversation.feed'] ?? [],
    (params, context): FeedPage => {
      // ADR-031 item 2: a viewer reads its own dwarf only; one bound to no dwarf reads nothing.
      if (context.role === 'viewer' && context.dwarfId !== params.dwarfId) {
        throw new CallError('FORBIDDEN')
      }
      const request = params.page
      const page = deps.conversation.feed(
        params.dwarfId as string as DwarfId,
        request === undefined
          ? undefined
          : {
              ...(request.before === undefined
                ? {}
                : { before: request.before as string as MessageId }),
              ...(request.limit === undefined ? {} : { limit: request.limit })
            }
      )
      return {
        dwarfId: params.dwarfId,
        messages: page.messages.map(toMessageWire),
        reachedStart: page.reachedStart
      }
    }
  )
}
