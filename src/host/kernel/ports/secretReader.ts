// Kernel driven port (16 §3 row `SecretReader`; 05 §3 kernel ports; ADR-017 item 1; AR-15, review
// R8B-05): the one way a Host consumer reads a secret value — the Jev router path and the
// delegation coordinator (the Jev key), the OpenCode answer adapter (the OpenCode password). It is a
// kernel port so that asking needs no jev import; its only implementation is the `host/wiring`
// bridge to the preferences `SecretStore` (host/wiring/bridges/secretReader.ts).
//
// - Only the allowlisted names are read; any other name is refused (a wiring defect).
// - `null` = not configured. `'timeout'` after `SECRET_READ_TIMEOUT_MS` (16 §2.6): a blocking
//   keychain never hangs a caller, which maps it to `jev-unreachable` or
//   `refused: 'channel-unavailable'`.
// - The value is never logged, stored, put in argv or env, or echoed to a UI (16 §2.7; ADR-017
//   item 3). Never read inside a transaction (16 §2.2).
//
// `SecretName` is ADR-017 item 1's type. It lives here, in the kernel, because the kernel port reads
// it and the kernel imports no module; the preferences `SecretStore` port imports it from here.

/** ADR-017 item 1: the names DwarfAI stores (used by ADR-023's reset saga and 05). */
export type SecretName = 'jev-key' | 'opencode-password'

/** A secret's value as the reader answers it: never logged, stored or echoed. */
export type SecretValue = string

/** The allowlist of `SecretReader.read` (16 §3): every `SecretName`, and nothing else. */
export const SECRET_NAMES: readonly SecretName[] = Object.freeze(['jev-key', 'opencode-password'])

/** 16 §2.6: how long a read may wait on the secret store before it answers `'timeout'`. */
export const SECRET_READ_TIMEOUT_MS = 10_000

export interface SecretReader {
  /** `null` = not configured; `'timeout'` after `SECRET_READ_TIMEOUT_MS`. */
  read(name: SecretName): Promise<SecretValue | null | 'timeout'>
}
