// Driven ports of the delegation module (05 §3.8, 16 §4.8; ADR-013 item 3): the durable record of
// every delegation and of every delegating session's per-launch credential. Type-only (R2).
//
// - `DelegationTicketStore` keeps the 06 §11.1 `Delegation` aggregate in `delegations` (09 §4.6),
//   looked up by its ticket (AR-19a applied). The table's CHECKs are the store's rules: `succeeded`
//   only with `handoff.phase = 'delivered'` (INV-68); the task and context only while the
//   delegation is in flight.
// - `DelegationTokenStore` keeps the 06 `DelegationToken` in `delegation_tokens`: one row per
//   launch (`launch_id` PK), the SHA-256 of the credential only, and only for `ticket-file` (09
//   §4.6 CHECK). The credential value never reaches either store (ADR-013 item 3, INV-83).
//   `byLaunch` finds a token until it is revoked; a revoked row is kept until its launch's
//   retention (06 §11.1) but is never returned, so a revoked token never authenticates (16 §5.7).
//
// Both are read and written inside the caller's transaction (16 §2.2).
import type { DwarfId, Instant, LaunchId } from '../../../kernel/domain/values'
import type { Delegation } from '../domain/delegation'

/**
 * 06 §11.1 `DelegationToken`: per owned session with delegation. `credentialHash` (lower-case hex
 * SHA-256) only for `ticket-file`; the credential value is never a field (ADR-013 item 3).
 */
export interface DelegationToken {
  readonly launchId: LaunchId
  readonly parentDwarfId: DwarfId
  readonly mechanism: 'in-process' | 'protocol' | 'ticket-file'
  readonly credentialHash?: string
  readonly issuedAt: Instant
  readonly revokedAt?: Instant
}

// As 16 §4.8 writes them (names, members and comments; layout by prettier)
export interface DelegationTicketStore {
  put(d: Delegation): void
  byTicket(ticket: string): Delegation | null
  save(d: Delegation): void
} // delegations; 06 §11.1 Delegation (state, failure, handoff)
export interface DelegationTokenStore {
  issue(t: DelegationToken): void
  byLaunch(id: LaunchId): DelegationToken | null
  revoke(id: LaunchId, at: Instant): void
} // delegation_tokens; 06 DelegationToken (hash only)
