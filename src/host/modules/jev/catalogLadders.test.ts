import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS } from '../../../contracts/catalog/ids'
import { PROVIDER_EFFORT_LEVELS } from './domain/capabilities/effortLadders'
import { MODEL_CAPABILITIES } from './domain/capabilities/modelCapability'

// The jev tables against the one catalog id list (`contracts/catalog/ids.mjs`): kept outside
// `domain/`, which never imports `contracts` (R1).
describe('the jev tables cover the catalog', () => {
  it('[ADR-028] every catalog provider has an effort ladder of distinct levels, and nothing else does', () => {
    expect(Object.keys(PROVIDER_EFFORT_LEVELS)).toEqual([...CATALOG_PROVIDER_IDS])
    for (const ladder of Object.values(PROVIDER_EFFORT_LEVELS)) {
      expect(new Set(ladder).size).toBe(ladder.length)
    }
  })

  it('[ADR-028] every catalog provider has a capability table whose effort levels sit on its own ladder', () => {
    expect(Object.keys(MODEL_CAPABILITIES)).toEqual([...CATALOG_PROVIDER_IDS])
    for (const [provider, table] of Object.entries(MODEL_CAPABILITIES)) {
      const ladder = PROVIDER_EFFORT_LEVELS[provider] ?? []
      for (const [id, entry] of Object.entries(table)) {
        if (entry.effortLevels === 'all') continue
        for (const level of entry.effortLevels) {
          expect(ladder, `${provider} ${id} names ${level}`).toContain(level)
        }
      }
    }
  })
})
