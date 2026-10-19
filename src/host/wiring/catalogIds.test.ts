// layer: L1
// The catalog-id consistency the wiring relies on (R9, R12; ISSUE-143 gap 2): `host/wiring` hands
// `CATALOG_PROVIDER_IDS` to the suppliers module, ESLint's R12 provider-literal list is derived from
// the same list, and every catalog record must name one of those ids. A profile id outside it would
// be a provider the R12 rule cannot see.
import { describe, expect, it } from 'vitest'
import { CATALOG_PROVIDER_IDS } from '@dwarfai/contracts'
import { CATALOG_RECORDS, SIMULATED_RECORD } from '../modules/suppliers/adapters/catalog/profiles'

describe('catalog ids', () => {
  it('[R12] every catalog profile id is in CATALOG_PROVIDER_IDS', () => {
    const profileIds = [...CATALOG_RECORDS, SIMULATED_RECORD].map((record) => record.profile.id)

    expect(profileIds.length).toBeGreaterThan(0)
    for (const id of profileIds) expect(CATALOG_PROVIDER_IDS).toContain(id)
  })
})
