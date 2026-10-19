// The channel token hashes over their in-memory double, for L2 tests outside the module (the hook
// ingress check in host/transport/auth), which reach the module only through its index or its
// testing folder (05 R15). `issue` mints a token as the issuer does (32 random bytes as lower-case
// hex, ADR-016 item 1), stores only its SHA-256 and returns the token to the test. The tokens are
// drawn at run time, so no token value is written into the repository. Never imported by
// production code (R14).
import { createHash, randomBytes } from 'node:crypto'
import type { Instant } from '../../../kernel/domain/values'
import type { TokenChannel } from '../ports/channelTokenStore'
import { InMemoryChannelTokenStore } from '../ports/fakes/InMemoryChannelTokenStore'

/** A fresh token as the issuer mints it: 32 random bytes as lower-case hex (ADR-016 item 1). */
export function drawToken(): string {
  return randomBytes(32).toString('hex')
}

/** The stored form of `token`: the SHA-256 of its hex text, as lower-case hex. */
export function hashOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function inMemoryChannelTokens() {
  const store = new InMemoryChannelTokenStore()
  return {
    store,
    /** Issues a fresh token for `channel` (revoking its previous one) and returns it. */
    issue(channel: TokenChannel, at: Instant): string {
      const token = drawToken()
      store.issue(channel, hashOf(token), at)
      return token
    }
  }
}
