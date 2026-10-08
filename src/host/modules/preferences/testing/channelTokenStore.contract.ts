// The ChannelTokenStore conformance suite (16 §4.12; ADR-016 item 1; 17 §1.3): run on the
// in-memory double and on the SQLite adapter over the template database (schema v1). Only the
// SHA-256 of a token is ever stored; issuing a new token revokes the channel's previous one and
// leaves the other channel's token untouched (one active row per channel, 09 §4.8); `revoke` leaves
// the channel without a token; the store joins the caller's transaction, so a rollback undoes its
// write. Never imported by production code (R14).
//
// The tokens are drawn at run time, so no token value is ever written into the repository.
import { afterEach, describe, expect, it } from 'vitest'
import type { Instant } from '../../../kernel/domain/values'
import type { ChannelTokenStore, TokenChannel } from '../ports/channelTokenStore'
import { drawToken, hashOf } from './inMemoryChannelTokens'

/** One stored row, as the subject holds it. */
export interface StoredChannelToken {
  channel: TokenChannel
  hash: string
  createdAt: Instant
  revokedAt: Instant | null
}

export interface ChannelTokenStoreSubject {
  store: ChannelTokenStore
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** Every stored row, revoked ones included, oldest first. */
  rows(): StoredChannelToken[]
  /** Every value the subject stores, serialized, to prove what never reaches it. */
  storedText(): string
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const T0: Instant = 1_750_000_000_000
const T1: Instant = T0 + 60_000
const T2: Instant = T0 + 120_000

export function runChannelTokenStoreContract(
  makeSubject: () => ChannelTokenStoreSubject | Promise<ChannelTokenStoreSubject>
): void {
  describe('ChannelTokenStore contract', () => {
    let subject: ChannelTokenStoreSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async (): Promise<ChannelTokenStoreSubject> => {
      subject = await makeSubject()
      return subject
    }

    const issue = (
      s: ChannelTokenStoreSubject,
      channel: TokenChannel,
      hash: string,
      at: Instant
    ): void => s.inTransaction(() => s.store.issue(channel, hash, at))

    it('[ADR-016] only the SHA-256 of an issued token is stored and active returns it', async () => {
      const s = await setUp()
      const token = drawToken()
      const hash = hashOf(token)

      expect(s.store.active('claude-hooks')).toBeNull()
      issue(s, 'claude-hooks', hash, T0)

      expect(s.store.active('claude-hooks')).toStrictEqual({ hash })
      expect(s.store.active('opencode-plugin')).toBeNull()
      expect(s.rows()).toStrictEqual([
        { channel: 'claude-hooks', hash, createdAt: T0, revokedAt: null }
      ])
      const stored = s.storedText()
      expect(stored).toContain(hash)
      expect(stored).not.toContain(token)
      expect(stored.toLowerCase()).not.toContain(token.toLowerCase())
    })

    it("[ADR-016] issuing a new token for a channel revokes the previous one; the other channel's token is untouched", async () => {
      const s = await setUp()
      const first = hashOf(drawToken())
      const plugin = hashOf(drawToken())
      const second = hashOf(drawToken())

      issue(s, 'claude-hooks', first, T0)
      issue(s, 'opencode-plugin', plugin, T0)
      issue(s, 'claude-hooks', second, T1)

      expect(s.store.active('claude-hooks')).toStrictEqual({ hash: second })
      expect(s.store.active('opencode-plugin')).toStrictEqual({ hash: plugin })
      expect(s.rows()).toStrictEqual([
        { channel: 'claude-hooks', hash: first, createdAt: T0, revokedAt: T1 },
        { channel: 'opencode-plugin', hash: plugin, createdAt: T0, revokedAt: null },
        { channel: 'claude-hooks', hash: second, createdAt: T1, revokedAt: null }
      ])
    })

    it('[ADR-016] revoke leaves the channel without an active token; a second revoke and a revoke with no token change nothing', async () => {
      const s = await setUp()
      const hooks = hashOf(drawToken())
      const plugin = hashOf(drawToken())
      issue(s, 'claude-hooks', hooks, T0)
      issue(s, 'opencode-plugin', plugin, T0)

      s.inTransaction(() => s.store.revoke('claude-hooks', T1))
      s.inTransaction(() => s.store.revoke('claude-hooks', T2))

      expect(s.store.active('claude-hooks')).toBeNull()
      expect(s.store.active('opencode-plugin')).toStrictEqual({ hash: plugin })
      expect(s.rows()).toStrictEqual([
        { channel: 'claude-hooks', hash: hooks, createdAt: T0, revokedAt: T1 },
        { channel: 'opencode-plugin', hash: plugin, createdAt: T0, revokedAt: null }
      ])
    })

    it('[ADR-016] a rolled-back caller transaction leaves the previous token active', async () => {
      const s = await setUp()
      const kept = hashOf(drawToken())
      issue(s, 'opencode-plugin', kept, T0)

      expect(() =>
        s.inTransaction(() => {
          s.store.issue('opencode-plugin', hashOf(drawToken()), T1)
          throw new CallerFailure('the caller failed after the issue')
        })
      ).toThrow(CallerFailure)

      expect(s.store.active('opencode-plugin')).toStrictEqual({ hash: kept })
      expect(s.rows()).toStrictEqual([
        { channel: 'opencode-plugin', hash: kept, createdAt: T0, revokedAt: null }
      ])
    })

    it('[ADR-016] a hash that is not 64 characters, or one already stored, is refused and the active token stays', async () => {
      const s = await setUp()
      const kept = hashOf(drawToken())
      issue(s, 'claude-hooks', kept, T0)

      expect(() => issue(s, 'claude-hooks', kept.slice(0, 63), T1)).toThrow()
      expect(() => issue(s, 'claude-hooks', `${kept}0`, T1)).toThrow()
      expect(() => issue(s, 'opencode-plugin', kept, T1)).toThrow()

      expect(s.store.active('claude-hooks')).toStrictEqual({ hash: kept })
      expect(s.store.active('opencode-plugin')).toBeNull()
      expect(s.rows()).toStrictEqual([
        { channel: 'claude-hooks', hash: kept, createdAt: T0, revokedAt: null }
      ])
    })
  })
}
