// layer: L1
// L1 (17 §1.1): the creditability rule of 09 §5.3 step 2 and the material arithmetic of 06 §13.1,
// pure. The transplanted `ledger.test.ts:166` ("never credits coal from live observation") is the
// INV-95 case.
import { describe, expect, it } from 'vitest'
import { decideCredit, usageTokens, type CreditFacts, type UsageUnit } from './credit'
import * as materials from './materials'
import { MATERIALS, TOKENS_PER_UNIT, unitsOf, zeroTotals, type LiveMaterial } from './materials'

const INSTALL = 1_760_000_000_000

function unit(overrides: Partial<UsageUnit> = {}): UsageUnit {
  return {
    unitKey: 'claude:session-1:msg-1',
    sealed: true,
    providerTime: INSTALL + 5_000,
    firstObservedAt: INSTALL + 5_100,
    credited: false,
    ...overrides
  }
}

function facts(overrides: Partial<CreditFacts> = {}): CreditFacts {
  return {
    unit: unit(),
    installMomentAt: INSTALL,
    resetInProgress: false,
    tier: 'copper',
    authoritativeTokens: 60_000,
    ...overrides
  }
}

describe('the creditability rule (09 §5.3 step 2)', () => {
  it('[INV-91, ADR-006] a sealed unit is creditable once and a second observation of it is stored, never credited', () => {
    expect(decideCredit(facts())).toEqual({
      creditable: true,
      material: 'copper',
      tokens: 60_000,
      units: 2
    })
    // The same unit after its credit: a later observation is stored and never re-credited.
    expect(decideCredit(facts({ unit: unit({ credited: true }) }))).toEqual({
      creditable: false,
      reason: 'already-credited'
    })
    // Not sealed yet: kept, credited when its final record arrives (ADR-006 item 6).
    expect(decideCredit(facts({ unit: unit({ sealed: false }) }))).toEqual({
      creditable: false,
      reason: 'not-sealed'
    })
  })

  it('[US-MINE-010.AC02, INV-93] two materials are never summed and no function converts one into another', () => {
    // A credit's material is the mine's tier itself, and its units use only that material's figure.
    for (const tier of ['bronze', 'copper', 'silver', 'gold', 'uranium'] as const) {
      const decision = decideCredit(facts({ tier, authoritativeTokens: 1_000_000 }))
      expect(decision).toEqual({
        creditable: true,
        material: tier,
        tokens: 1_000_000,
        units: Math.floor(1_000_000 / TOKENS_PER_UNIT[tier])
      })
    }
    // Six separate counts, each its own object: nothing adds one into another.
    const totals = zeroTotals()
    expect(Object.keys(totals)).toEqual([...MATERIALS])
    totals.gold.tokens += 5
    expect(MATERIALS.filter((m) => totals[m].tokens !== 0)).toEqual(['gold'])
    // The value-object API has no sum, conversion or exchange between materials.
    const exported = Object.entries(materials)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
    expect(exported.sort()).toEqual(['unitsOf', 'zeroTotals'])
  })

  it("[US-MINES-007.AC02] each material's units use its own tokens-per-unit figure", () => {
    expect(TOKENS_PER_UNIT).toEqual({
      coal: 2_500,
      bronze: 10_000,
      copper: 25_000,
      silver: 50_000,
      gold: 100_000,
      uranium: 250_000
    })
    const tokens = 499_999
    expect(MATERIALS.map((m) => unitsOf(tokens, m))).toEqual([199, 49, 19, 9, 4, 1])
    // Units are floored: one token short of a unit is no unit.
    expect(unitsOf(TOKENS_PER_UNIT.silver - 1, 'silver')).toBe(0)
    expect(unitsOf(TOKENS_PER_UNIT.silver, 'silver')).toBe(1)
  })

  it('[INV-94] a unit of a never-measured mine is stored, not credited', () => {
    expect(decideCredit(facts({ tier: null }))).toEqual({
      creditable: false,
      reason: 'tier-unknown'
    })
  })

  it('[INV-95] a live observation never credits coal', () => {
    // Transplanted from `src/main/domain/ledger.test.ts:166` ("never credits coal from live
    // observation"): no tier is coal, and a coal "tier" handed in by mistake credits nothing.
    const coal = 'coal' as unknown as LiveMaterial
    expect(decideCredit(facts({ tier: coal }))).toEqual({
      creditable: false,
      reason: 'tier-unknown'
    })
  })

  it('[INV-97] while a reset saga is not done observations are stored and not credited', () => {
    expect(decideCredit(facts({ resetInProgress: true }))).toEqual({
      creditable: false,
      reason: 'reset-in-progress'
    })
    // Between the saga's `db` and `install-moment` steps there is no install moment (09 §5.5).
    expect(decideCredit(facts({ installMomentAt: null }))).toEqual({
      creditable: false,
      reason: 'no-install-moment'
    })
  })

  it('[ADR-006] a unit before the install moment is never credited live and one without a provider time counts after it only if first observed after it', () => {
    expect(decideCredit(facts({ unit: unit({ providerTime: INSTALL - 1 }) }))).toEqual({
      creditable: false,
      reason: 'before-install-moment'
    })
    expect(decideCredit(facts({ unit: unit({ providerTime: INSTALL }) }))).toMatchObject({
      creditable: true
    })
    expect(
      decideCredit(facts({ unit: unit({ providerTime: null, firstObservedAt: INSTALL - 1 }) }))
    ).toEqual({ creditable: false, reason: 'before-install-moment' })
    expect(
      decideCredit(facts({ unit: unit({ providerTime: null, firstObservedAt: INSTALL }) }))
    ).toMatchObject({ creditable: true })
  })

  it('[INV-92] a unit the authoritative path has not reported is stored, never credited', () => {
    expect(decideCredit(facts({ authoritativeTokens: null }))).toEqual({
      creditable: false,
      reason: 'not-authoritative-path'
    })
  })

  it('[ADR-006] the credited tokens are every kind of the observation added together', () => {
    expect(
      usageTokens({ inputNet: 1_000, output: 200, cacheRead: 4_000, cacheWrite: 30, reasoning: 7 })
    ).toBe(5_237)
  })
})
