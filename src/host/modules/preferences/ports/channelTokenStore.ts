// Driven port (05 §3.12, 16 §4.12; ADR-016 item 1): the per-channel token hashes of the loopback
// integration channels, in `channel_tokens` (09 §4.8). The store never sees a token, only its
// SHA-256 as lower-case hex: the plaintext lives only inside the owned entry the config writer puts
// on disk. Issuing a new token revokes the channel's previous one (one active row per channel); the
// hook ingress reads `active` to authenticate a request (host/transport/auth/channelTokenCheck.ts).
// Read and written inside the caller's transaction (16 §2.2).
import type { Instant } from '../../../kernel/domain/values'

// As 16 §4.12 writes it (names, members and comment; layout by prettier)
export interface ChannelTokenStore {
  issue(channel: 'claude-hooks' | 'opencode-plugin', hash: string, at: Instant): void
  active(channel: 'claude-hooks' | 'opencode-plugin'): { hash: string } | null
  revoke(channel: 'claude-hooks' | 'opencode-plugin', at: Instant): void
} // channel_tokens (ADR-016 item 1: SHA-256 only)

/**
 * Owner amendment M (2026-10-09): the member `ChannelTokenStore` gains. Kept apart from the owner
 * block above so that block stays as 16 §4.12 writes it.
 */
export interface ChannelTokenStore {
  // Amended: 16 §4.12 ChannelTokenStore.withdraw (owner amendment M, 2026-10-09; prior added on
  // review): 16 §7.3 Tx B (failure) takes back the Tx A issue of `hash` — its row is deleted and
  // `prior`, the hash that issue revoked (read with `active` in the same Tx A), is active again;
  // `null` reactivates nothing. A `prior` that is not the row that issue revoked, or a `hash` that is
  // not the channel's active row, throws `HostInvariantError`: a revoked token never comes back by
  // accident (ADR-016). Inside the caller's transaction (16 §2.2).
  withdraw(
    channel: 'claude-hooks' | 'opencode-plugin',
    hash: string,
    prior: string | null,
    at: Instant
  ): void
}

/** The channel a token belongs to, derived from the port (never restated). */
export type TokenChannel = Parameters<ChannelTokenStore['issue']>[0]
