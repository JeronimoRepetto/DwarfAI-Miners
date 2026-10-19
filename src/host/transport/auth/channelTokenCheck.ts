// The hook ingress credential check (ADR-016 items 1–2; 16 §4.12 `ChannelTokenStore`, read by the
// hook ingress; 13 FM-038). Each loopback integration channel has its own token, 32 random bytes as
// lower-case hex; the Host keeps only the SHA-256 of that hex text (`channel_tokens`).
//
// `authenticate(channel, presented)`:
// - refuses anything that is not 64 lower-case hex characters before hashing it (the hex check of
//   the legacy `TOKEN_PATTERN`, at the new length), so a malformed value never throws;
// - hashes the presented text and compares the two 32-byte digests with `crypto.timingSafeEqual`
//   against the active hash of **its own** channel only: a revoked token, or one channel's token on
//   the other channel's route, never authenticates (ADR-016 item 2: `401`). A channel with no active
//   token runs the same comparison, against itself, and still refuses;
// - records each refusal as `ingress.rejected` (19 §9.2: `causeClass` `401`, `subsystem` the
//   channel). Neither the token nor its hash ever reaches a log record (NFR-SEC-12, ADR-026).
// The ingress routes and their hardening (`127.0.0.1`, `Origin`, `Host`, body cap) are not here
// (ISSUE-133, ISSUE-229).
import { createHash, timingSafeEqual } from 'node:crypto'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { ChannelTokenStore, TokenChannel } from '../../modules/preferences'

/** A channel token: 32 bytes as lower-case hex (ADR-016 item 1). */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const DIGEST_BYTES = 32

export interface ChannelTokenCheckDeps {
  /** The stored hashes; only `active` is read. */
  tokens: Pick<ChannelTokenStore, 'active'>
  log: DiagnosticsLog
  /** Defaults to SHA-256 over the UTF-8 text. */
  sha256?: (text: string) => Uint8Array
  /** Defaults to `crypto.timingSafeEqual`. */
  timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean
}

export class ChannelTokenCheck {
  private readonly hash: (text: string) => Uint8Array
  private readonly equal: (a: Uint8Array, b: Uint8Array) => boolean

  constructor(private readonly deps: ChannelTokenCheckDeps) {
    this.hash = deps.sha256 ?? sha256
    this.equal = deps.timingSafeEqual ?? timingSafeEqual
  }

  /** True only for the active token of `channel`. */
  authenticate(channel: TokenChannel, presented: unknown): boolean {
    if (typeof presented !== 'string' || !TOKEN_PATTERN.test(presented)) {
      return this.refuse(channel)
    }
    const actual = this.hash(presented)
    const expected = storedDigest(this.deps.tokens.active(channel))
    if (expected === null) {
      // Same work as a real comparison, against itself, and still a refusal.
      this.equal(actual, actual)
      return this.refuse(channel)
    }
    return this.equal(actual, expected) || this.refuse(channel)
  }

  private refuse(channel: TokenChannel): false {
    this.deps.log.record({
      level: 'warn',
      event: 'ingress.rejected',
      subsystem: channel,
      causeClass: '401'
    })
    return false
  }
}

function sha256(text: string): Uint8Array {
  return createHash('sha256').update(text, 'utf8').digest()
}

/** The active row's hash as 32 bytes, or `null` when the channel has none. */
function storedDigest(active: { hash: string } | null): Uint8Array | null {
  if (active === null || !TOKEN_PATTERN.test(active.hash)) return null
  const digest = Buffer.from(active.hash, 'hex')
  return digest.length === DIGEST_BYTES ? digest : null
}
