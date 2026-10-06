// B-M27 `conversation.mineHistory` (14 §2.3, §3.4, §3.6 `MineHistoryView`, frozen; ADR-003 item 12;
// ADR-007 item 5; PO #87): a mine's history from the Host's message log — every dwarf that worked
// there, present or departed, with the same ≤ 50 rows the feed pages, undelivered ones included. It
// never reads a provider file. The conversation wiring registers it over the module
// (host/wiring/routes/conversation.ts, ISSUE-108); UI main's A-19 relays it (ui-main/ipc/handlers/getMineHistory.host.ts, routed
// by ISSUE-123).
//
// - Roles (roles.ts): `ui` only; a `notifier` or a `viewer` gets FORBIDDEN before the handler runs.
// - A query: no requestId, no effect, no frame. The params are the contract's strict() schema
//   (INVALID_PARAMS otherwise, before the handler runs).
// - The result is sensitive (14 §3.5 SENSITIVE_METHODS `'result'`): message text. The dispatcher
//   logs the method name, outcome and code only, and nothing here logs.
import { HOST_METHOD_SCHEMAS, type MineHistoryView } from '@dwarfai/contracts'
import type { MineId } from '../../kernel/domain/values'
import type { ConversationQueries } from '../../modules/conversation'
import type { Dispatcher } from '../dispatcher'
import { toMessageWire } from '../mappers/wire'
import { METHOD_ROLES } from '../roles'

export interface ConversationMineHistoryDeps {
  conversation: Pick<ConversationQueries, 'mineHistory'>
}

/** Serves `conversation.mineHistory` (B-M27) on `dispatcher`. */
export function registerConversationMineHistory(
  dispatcher: Dispatcher,
  deps: ConversationMineHistoryDeps
): void {
  dispatcher.register(
    'conversation.mineHistory',
    HOST_METHOD_SCHEMAS['conversation.mineHistory'].params,
    METHOD_ROLES['conversation.mineHistory'] ?? [],
    (params): MineHistoryView => {
      const history = deps.conversation.mineHistory(params.mineId as string as MineId)
      return {
        mineId: params.mineId,
        speakers: history.speakers.map((speaker) => ({
          dwarfId: speaker.dwarfId,
          displayName: speaker.displayName,
          departed: speaker.departed,
          messages: speaker.messages.map(toMessageWire)
        }))
      }
    }
  )
}
