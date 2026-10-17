// 06 §14.2 `SecretStatus { name, configured }` (ADR-017; 16 §4.12): the one thing the module knows
// of a secret. Secrets are not domain entities (06 D-28): the value lives in the OS secret store
// behind `SecretStore`, and this value object carries a configured flag only, never the value
// (INV-107).
//
// Package gap: 16 §3 declares `SecretName` once, with the kernel `SecretReader` port
// (kernel/ports/secretReader.ts), and a domain file may import only its own domain and the kernel
// domain (05 §5.1 R1). The domain therefore names the same two values here; secretStatus.test.ts
// fails to compile when the two declarations ever differ.

/** ADR-017 item 1 `SecretName`, as the kernel declares it (see above). */
export type SecretStatusName = 'jev-key' | 'opencode-password'

/** 06 §14.2: whether the named secret is configured; never its value. */
export interface SecretStatus {
  name: SecretStatusName
  configured: boolean
}
