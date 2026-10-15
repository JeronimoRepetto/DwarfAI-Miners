// The narrow binding `OsKeyringSecretStore` drives (ADR-017 item 2; 16 §4.12.1 "Adapter"): exactly
// what the adapter needs from the OS keyring library — one generic-password entry addressed by
// (service, account) — and nothing more. The adapter owns the naming, the error mapping, the
// no-plain-text-fallback rule and the logging; a binding only talks to the OS secret store.
//
// COMPOSITION SEAM (lead decision 2026-10-15). The keyring library is not a dependency yet: spike
// SP-16 (ISSUE-322) chooses it and its own dependency-only PR adds it. That PR adds the one module
// of the codebase that imports the library, beside this file (R11: the keyring library only under
// `preferences/adapters/secret-store/**`), implementing `KeyringBinding` with the library's
// non-blocking API; the wiring then composes `new OsKeyringSecretStore(<that binding>, log)` where
// it composes `unavailableSecretStore` today (later: ISSUE-324). Until then no real binding exists
// and nothing pretends to be one.
//
// Rules every binding keeps:
// - No method blocks the event loop: a blocking native call runs off it (ADR-017 item 1).
// - `available()` answers whether a usable OS secret service is reachable (Linux without a Secret
//   Service answers `false`, FM-115).
// - When the secret service is unusable at call time, a method rejects with `KeyringUnavailable`;
//   any other failure rejects with whatever the library threw. The adapter never forwards either
//   error's message, so a library message that echoes a value never reaches a caller or a log.
// - A binding never stores anything anywhere but the OS secret store: no file, no cache on disk
//   (ADR-017 items 3, 5).

/** The secret service is not usable at call time (no Secret Service, no keychain access). */
export class KeyringUnavailable extends Error {
  constructor() {
    super('KeyringUnavailable: no usable OS secret service')
    this.name = 'KeyringUnavailable'
  }
}

export interface KeyringBinding {
  /** Whether a usable OS secret service is reachable. */
  available(): Promise<boolean>
  /** The entry's value; `null` when no entry exists. */
  read(service: string, account: string): Promise<string | null>
  /** Creates or replaces the entry. */
  write(service: string, account: string, value: string): Promise<void>
  /** Removes the entry; resolves also when no entry exists. */
  remove(service: string, account: string): Promise<void>
}
