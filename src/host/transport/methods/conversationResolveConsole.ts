// B-M29 `conversation.resolveConsole` (14 §2.3, frozen; ADR-031 items 1–4; UC-036): the Host half of
// A-13 `activateDwarf` (split: UI main calls this, then `NativeActions.raiseConsole`). The composition
// root registers it over the conversation module (host/wiring/routes/conversation.ts, ISSUE-170).
//
// - Roles (roles.ts): `ui` only; a `viewer` or `notifier` gets FORBIDDEN before the handler runs.
// - A query: no requestId, no frame, and no ask is read or answered (US-MSG-007.AC02). It issues a
//   per-view token for the `log` view (ADR-003 item 12) and answers its file's path only.
// - The params and the result are the contract's strict() schemas (INVALID_PARAMS otherwise). The
//   result is sensitive (14 §3.5 SENSITIVE_METHODS `'result'`: paths): the dispatcher logs the
//   method name, outcome and code only, and nothing here logs.
import { HOST_METHOD_SCHEMAS, type ConsoleTarget } from '@dwarfai/contracts'
import type { DwarfId } from '../../kernel/domain/values'
import type { ResolveConsole } from '../../modules/conversation'
import type { Dispatcher } from '../dispatcher'
import { METHOD_ROLES } from '../roles'

export interface ConversationResolveConsoleDeps {
  conversation: ResolveConsole
}

/** Serves `conversation.resolveConsole` (B-M29) on `dispatcher`. */
export function registerConversationResolveConsole(
  dispatcher: Dispatcher,
  deps: ConversationResolveConsoleDeps
): void {
  dispatcher.register(
    'conversation.resolveConsole',
    HOST_METHOD_SCHEMAS['conversation.resolveConsole'].params,
    METHOD_ROLES['conversation.resolveConsole'] ?? [],
    async (params): Promise<ConsoleTarget> => {
      const target = await deps.conversation.resolveConsole(params.dwarfId as string as DwarfId)
      // Exactly the fields ADR-031 names, copied, so nothing else the resolver might hold crosses.
      return {
        mode: target.mode,
        ...(target.focus === undefined
          ? {}
          : { focus: { pid: target.focus.pid, startTime: target.focus.startTime } }),
        ...(target.command === undefined
          ? {}
          : {
              command: {
                program: target.command.program,
                args: [...target.command.args],
                cwd: target.command.cwd
              }
            }),
        ...(target.credentialFile === undefined ? {} : { credentialFile: target.credentialFile })
      }
    }
  )
}
