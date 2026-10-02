import { describe, expect, it } from 'vitest'
import { providerIdentityKey, sameProviderIdentity } from './providerIdentity'
import type { ProviderIdentity } from './values'

const ROOT: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-1' }

describe('ProviderIdentity (06 §3; ADR-015 item 7)', () => {
  it('[INV-21] two identities are equal iff all three parts are, an absent agent id equal to an empty one', () => {
    const rows: ReadonlyArray<{ other: ProviderIdentity; same: boolean }> = [
      { other: { ...ROOT }, same: true },
      { other: { ...ROOT, providerAgentId: '' }, same: true },
      { other: { ...ROOT, providerAgentId: 'agent-7' }, same: false },
      { other: { ...ROOT, providerSessionId: 'session-2' }, same: false },
      { other: { ...ROOT, providerId: 'codex' }, same: false }
    ]
    for (const { other, same } of rows) {
      expect({ other, same: sameProviderIdentity(ROOT, other) }).toEqual({ other, same })
      expect({ other, same: providerIdentityKey(ROOT) === providerIdentityKey(other) }).toEqual({
        other,
        same
      })
    }
  })

  it('[INV-21] the key never merges two identities whose parts only concatenate alike', () => {
    const pairs: ReadonlyArray<[ProviderIdentity, ProviderIdentity]> = [
      [
        { providerId: 'ab', providerSessionId: 'c' },
        { providerId: 'a', providerSessionId: 'bc' }
      ],
      [
        { providerId: 'a:b', providerSessionId: 'c' },
        { providerId: 'a', providerSessionId: 'b:c' }
      ],
      [
        { providerId: 'a', providerSessionId: 'b', providerAgentId: 'c' },
        { providerId: 'a', providerSessionId: 'bc' }
      ]
    ]
    for (const [a, b] of pairs) expect(providerIdentityKey(a)).not.toBe(providerIdentityKey(b))
  })
})
