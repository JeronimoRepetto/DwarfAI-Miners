// Driven ports of the delegation module (05 §3.8, 16 §4.8; ADR-013 item 3): the durable record of
// every delegation and of every delegating session's per-launch credential. Type-only (R2).
//
// - `DelegationTicketStore` keeps the 06 §11.1 `Delegation` aggregate in `delegations` (09 §4.6),
//   looked up by its ticket (AR-19a applied). The table's CHECKs are the store's rules: `succeeded`
//   only with `handoff.phase = 'delivered'` (INV-68); the task and context only while the
//   delegation is in flight.
// - `DelegationTokenStore` keeps the 06 `DelegationToken` in `delegation_tokens`: one row per
//   launch (`launch_id` PK), the SHA-256 of the credential only, and only for the relay entries
//   `ticket-file` and `protocol` (09 §4.6 CHECK). The credential value never reaches either store
//   (ADR-013 item 3, INV-83). `byLaunch` finds a token until it is revoked; a revoked row is kept
//   until its launch's retention (06 §11.1) but is never returned, so a revoked token never
//   authenticates (16 §5.7). The row is written before the driver starts, when the launch's dwarf
//   does not exist yet: its parent is NULL until `bindParent` sets it once on `DwarfLaunched`.
// - `CredentialFileStore` owns the per-launch credential files `<hostDataDir>/run/mcp/<launchId>.cred`
//   (exclusive create, `0600` in a `0700` directory, the Windows owner-only ACL per SP-05).
//
// Owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15: `inFlight`, `bindParent`, `live`, the
// nullable parent, the `protocol` hash and `CredentialFileStore` (A14-03 … A14-06).
//
// Both are read and written inside the caller's transaction (16 §2.2).
import type { DwarfId, Instant, LaunchId, Result } from '../../../kernel/domain/values'
import type { FsError } from '../../../kernel/ports/fileSystem'
import type { Delegation } from '../domain/delegation'

/**
 * 06 §11.1 `DelegationToken`: per owned session with delegation. `parentDwarfId` is `null` until
 * the launch's dwarf arrives; `credentialHash` (lower-case hex SHA-256) for `ticket-file` and
 * `protocol`; the credential value is never a field (ADR-013 item 3).
 */
export interface DelegationToken {
  readonly launchId: LaunchId
  readonly parentDwarfId: DwarfId | null
  readonly mechanism: 'in-process' | 'protocol' | 'ticket-file'
  readonly credentialHash?: string
  readonly issuedAt: Instant
  readonly revokedAt?: Instant
}

// As AMENDMENT-14 writes them for 05 §3.8 / 16 §4.8 (names, members and comments; layout by prettier)
export interface DelegationTicketStore {
  put(d: Delegation): void
  byTicket(ticket: string): Delegation | null
  inFlight(): Delegation[]
  save(d: Delegation): void
} // delegations; 06 §11.1 Delegation (state, failure, handoff); inFlight = attempted/running
export interface DelegationTokenStore {
  issue(t: DelegationToken): void
  byLaunch(id: LaunchId): DelegationToken | null
  bindParent(id: LaunchId, parent: DwarfId): void
  live(): DelegationToken[]
  revoke(id: LaunchId, at: Instant): void
} // delegation_tokens; 06 DelegationToken (hash only); live = not revoked
export interface CredentialFileStore {
  write(
    launchId: LaunchId,
    credential: string
  ): Promise<Result<{ path: string }, 'exists' | FsError>>
  remove(launchId: LaunchId): Promise<void>
  list(): Promise<LaunchId[]>
} // <hostDataDir>/run/mcp/<launchId>.cred, exclusive create, 0600 in a 0700 dir, Windows ACL per SP-05 (ADR-013 item 3); the value is never logged
