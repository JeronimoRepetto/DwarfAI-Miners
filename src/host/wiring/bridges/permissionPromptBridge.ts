// The permission prompt bridge (AMENDMENT-21, owner-approved 2026-10-17; ADR-013 item 3; ADR-010
// items 1, 5): module delegation's `PermissionPromptEndpoint` (the Host MCP endpoint's
// `permission` tool) over the Claude stream-json driver's `PromptToolSessions` (module suppliers).
//
// - A session registers under its launch id before its spawn, with whether both delegation gates
//   let its launch in, and unregisters when it ends; a later registration of the same launch (a
//   resume) replaces it, and the older one's unregister then removes nothing.
// - `serves(token)`: the token's own launch has a session now and the token is not revoked. The
//   relay connection's token is the one the transport bound at authentication (ADR-013 item 3), so
//   a credential reaches the session of its own launch only; any other launch, a driver without
//   the prompt tool included, is not served.
// - `delegationGated(token)`: the registered gate of a served launch (false otherwise). The MCP
//   server lists an ungated session `permission` only, never the two delegation tools (INV-80).
// - `decide`: hands the call (and its cancellation signal) to that session, whose ask goes to the
//   single ask broker; a launch with no session is denied without asking (fail closed, 15 §2.7).
//
// Composed by the composition root with the stream-json driver and the MCP server (no `ask.opened`
// path exists before both are composed).
import type { LaunchId } from '../../kernel/domain/values'
import type {
  DelegationToken,
  PermissionPromptCall,
  PermissionPromptEndpoint
} from '../../modules/delegation'
import type {
  PromptToolHandler,
  PromptToolScope,
  PromptToolSessions
} from '../../modules/suppliers/adapters/drivers/claude-stream-json/promptTool'

interface Registration {
  readonly handler: PromptToolHandler
  readonly delegationGated: boolean
}

export class PermissionPromptBridge implements PromptToolSessions, PermissionPromptEndpoint {
  private readonly sessions = new Map<LaunchId, Registration>()

  register(launchId: LaunchId, scope: PromptToolScope, handler: PromptToolHandler): () => void {
    const registration: Registration = { handler, delegationGated: scope.delegationGated }
    this.sessions.set(launchId, registration)
    return () => {
      if (this.sessions.get(launchId) === registration) this.sessions.delete(launchId)
    }
  }

  serves(token: DelegationToken): boolean {
    return this.registrationOf(token) !== undefined
  }

  delegationGated(token: DelegationToken): boolean {
    return this.registrationOf(token)?.delegationGated === true
  }

  async decide(
    token: DelegationToken,
    call: PermissionPromptCall,
    signal: AbortSignal
  ): Promise<'allow' | 'deny'> {
    const registration = this.registrationOf(token)
    return registration === undefined ? 'deny' : registration.handler(call, signal)
  }

  private registrationOf(token: DelegationToken): Registration | undefined {
    return token.revokedAt === undefined ? this.sessions.get(token.launchId) : undefined
  }
}
