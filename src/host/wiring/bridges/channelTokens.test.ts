// layer: L2
// The channel-token lookup the hook ingress reads (ADR-016 items 1–2; 16 §4.12 `ChannelTokenStore`,
// "the hook ingress reads `active`"): the active hash of a channel and nothing else, so the ingress
// can authenticate a request but never issue, revoke or withdraw a token.
import { describe, expect, it } from 'vitest'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { Instant } from '../../kernel/domain/values'
import { SqliteChannelTokenStore } from '../../modules/preferences/adapters/sqlite/SqliteChannelTokenStore'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { ingressChannelTokens } from './channelTokens'

const FIRST = '1'.repeat(64)
const SECOND = '2'.repeat(64)

describe('ChannelTokenStore lookup bridge (preferences → hook ingress)', () => {
  it('[ADR-016] the lookup answers only the active hash of its own channel: a rotated-out hash is never returned', () => {
    const { db } = openTemplateCopy()
    const store = new SqliteChannelTokenStore({ db, ids: new SequenceIdGenerator() })
    const lookup = ingressChannelTokens(store)

    expect(lookup.active('claude-hooks')).toBeNull()
    store.issue('claude-hooks', FIRST, 1 as Instant)
    expect(lookup.active('claude-hooks')).toStrictEqual({ hash: FIRST })
    expect(lookup.active('opencode-plugin')).toBeNull()

    store.issue('claude-hooks', SECOND, 2 as Instant)
    expect(lookup.active('claude-hooks')).toStrictEqual({ hash: SECOND })

    store.revoke('claude-hooks', 3 as Instant)
    expect(lookup.active('claude-hooks')).toBeNull()
  })

  it('[ADR-016] the lookup exposes active alone: nothing that issues, revokes or withdraws a token', () => {
    const { db } = openTemplateCopy()
    const lookup = ingressChannelTokens(
      new SqliteChannelTokenStore({ db, ids: new SequenceIdGenerator() })
    )

    expect(Object.keys(lookup)).toStrictEqual(['active'])
  })
})
