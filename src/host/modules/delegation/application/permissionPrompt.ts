// `answerPermissionPrompt`: the `permission` tool over the PermissionPromptEndpoint port, as the
// MCP adapter runs it (AMENDMENT-21, owner-approved 2026-10-17; 15 §2.7; ADR-010 items 1, 5).
//
// Fail closed at every step: a malformed call, a token whose launch is not an owned Claude
// `stream-json` session (ADR-013 item 3: the credential is bound to its own launch) and any error
// of the bridge answer `deny`, and only the session's Allow answers `allow`. An error is logged by
// its class only, never with its message or the tool input (ADR-026, NFR-SEC-12).
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import {
  permissionPromptReply,
  readPermissionPromptCall,
  type PermissionPromptReply
} from '../domain/permissionPrompt'
import type { DelegationToken } from '../ports/delegationStores'
import type { PermissionPromptEndpoint } from '../ports/permissionPrompt'

export async function answerPermissionPrompt(
  endpoint: PermissionPromptEndpoint,
  token: DelegationToken,
  args: unknown,
  signal: AbortSignal,
  log: DiagnosticsLog
): Promise<PermissionPromptReply> {
  const call = readPermissionPromptCall(args)
  if (call === null || !endpoint.serves(token)) return permissionPromptReply(call, 'unavailable')
  try {
    return permissionPromptReply(call, await endpoint.decide(token, call, signal))
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    log.record({
      level: 'warn',
      event: 'delegation.permission.failed',
      subsystem: 'delegation',
      outcome: 'failed',
      causeClass: typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : 'unknown'
    })
    return permissionPromptReply(call, 'unavailable')
  }
}
