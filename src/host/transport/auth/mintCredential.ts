// Token issuance of the transport (05 §2.1 "token issuance"; ADR-016 item 1; lead decision
// 2026-09-30, ISSUE-198): no port of `16` gives a module's application randomness or hashing, and
// R3 forbids `node:*` there, so a credential is minted here and handed to the module by the
// composition root. One helper serves every loopback credential: the per-channel integration
// tokens (ISSUE-219, ISSUE-221) and the per-launch delegation credentials (later: ISSUE-198).
//
// The hash is the one ChannelTokenCheck verifies (channelTokenCheck.ts): SHA-256 over the UTF-8
// hex text, as lower-case hex. The value is returned to the caller only; nothing here logs it.
import { createHash, randomBytes } from 'node:crypto'
import type { MintedCredential } from '../../modules/preferences'

const CREDENTIAL_BYTES = 32

/**
 * Where a credential's bytes come from: the platform's cryptographic source (ADR-016 item 1). Injectable so a test can
 * prove the bytes are the source's; never a predictable generator such as `Math.random`.
 */
export const CREDENTIAL_RANDOM_SOURCE: (size: number) => Uint8Array = randomBytes

export function mintCredential(random = CREDENTIAL_RANDOM_SOURCE): MintedCredential {
  const value = Buffer.from(random(CREDENTIAL_BYTES)).toString('hex')
  return { value, sha256: createHash('sha256').update(value, 'utf8').digest('hex') }
}
