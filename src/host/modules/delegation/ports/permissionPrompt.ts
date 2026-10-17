// The permission prompt tool's driving port (AMENDMENT-21, owner-approved 2026-10-17; ADR-010
// items 1, 5; ADR-013 item 3). Type-only (R2).
//
// The MCP endpoint serves `permission` only to a relay connection whose credential belongs to an
// owned Claude `stream-json` session: `serves(token)` says whether the connection's launch is one,
// and `decide` hands one prompt to that session, which opens it as an ask of the single ask broker
// (its `DriverAskChannel` answers it) and settles with the person's Allow or Deny. The binding is
// the token's launch: a connection never reaches another launch's session. Implemented by the
// wiring bridge between this module and suppliers (host/wiring/bridges/permissionPromptBridge.ts).
import type { PermissionPromptCall } from '../domain/permissionPrompt'
import type { DelegationToken } from './delegationStores'

export interface PermissionPromptEndpoint {
  /** Whether the token's launch is an owned Claude `stream-json` session now. */
  serves(token: DelegationToken): boolean
  /**
   * The person's answer to one prompt of the token's own session. `signal` aborts when the tool
   * call is cancelled (the ask is then resolved `cancelled`). Rejects on a bridge failure.
   */
  decide(
    token: DelegationToken,
    call: PermissionPromptCall,
    signal: AbortSignal
  ): Promise<'allow' | 'deny'>
}
