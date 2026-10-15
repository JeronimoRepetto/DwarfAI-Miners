// Test credentials for the delegation suites (ADR-013 item 3): drawn at run time as the issuer
// mints them (32 random bytes as lower-case hex), so no credential value is written into the
// repository, and hashed as `delegation_tokens.credential_hash` stores them. Never imported by
// production code (R14).
import { createHash, randomBytes } from 'node:crypto'

export function drawCredential(): string {
  return randomBytes(32).toString('hex')
}

/** The stored form of a credential: the SHA-256 of its hex text, as lower-case hex. */
export function hashOf(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex')
}
