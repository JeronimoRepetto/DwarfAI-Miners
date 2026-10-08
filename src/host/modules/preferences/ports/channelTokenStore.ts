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

/** The channel a token belongs to, derived from the port (never restated). */
export type TokenChannel = Parameters<ChannelTokenStore['issue']>[0]
