// Driven port (ADR-017 item 1, owner; 16 §4.12, §4.12.1): the OS secret store, read and written by
// the Host only. Created by ISSUE-212 for the Reset saga's `secrets` step (lead decision
// 2026-09-30); its adapter `OsKeyringSecretStore` and its contract suite come with ISSUE-215,
// which keeps this file.
//
// - `delete` is idempotent and never throws for either outcome: an unavailable secret service is a
//   successful no-op (`'unavailable'`, AMENDMENT-2 AR-13-04). A `delete` that throws on an
//   available backend fails the saga step, which resumes at the next start (07 S13.07).
// - Never called inside a transaction (16 §2.2).
//
// `SecretName` (ADR-017 item 1) is declared once, with the kernel `SecretReader` port that reads it
// (kernel/ports/secretReader.ts; the kernel imports no module), and re-exported here.
import type { SecretName } from '../../../kernel/ports/secretReader'

export type { SecretName }

// As ADR-017 item 1 writes them (names, members and comments; layout by prettier)
export type SecretBackend = 'os-secret-store' | 'unavailable'
export interface SecretStore {
  // Host driven port
  backend(): Promise<SecretBackend> // 'unavailable' = no usable secret service (item 5)
  get(name: SecretName): Promise<string | null> // null = not configured
  has(name: SecretName): Promise<boolean> // drives the `configured` flags
  set(name: SecretName, value: string): Promise<void> // throws SecretStoreUnavailable when backend is 'unavailable'
  delete(name: SecretName): Promise<SecretDeleteOutcome> // idempotent; used by clear and by Reset metrics
}
export type SecretDeleteOutcome =
  // AMENDMENT-2 (AR-13-04); delete never throws for either value
  | 'deleted' // no entry is left (also when none was stored)
  | 'unavailable' // no usable secret service (item 5): a successful no-op
