import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import {
  BYTES_PER_KB,
  DEFAULT_TIER_THRESHOLDS,
  tierFor,
  tierThresholdsFrom,
  type Tier
} from './tier'

const bytes = (n: number): { bytes: number } => ({ bytes: n })

describe('tierFor and TierThresholds (06 §4.1, INV-05)', () => {
  it('[INV-05] 358 399 bytes is Bronze and 358 400 bytes is Copper', () => {
    expect(BYTES_PER_KB).toBe(1024)
    expect(tierFor(bytes(0), DEFAULT_TIER_THRESHOLDS)).toBe('bronze')
    expect(tierFor(bytes(358_399), DEFAULT_TIER_THRESHOLDS)).toBe('bronze')
    expect(tierFor(bytes(358_400), DEFAULT_TIER_THRESHOLDS)).toBe('copper')
  })

  it('[INV-05] the Silver, Gold and Uranium boundaries fall on whole KB of 1 024 bytes', () => {
    const cases: ReadonlyArray<[number, Tier]> = [
      [1_500 * 1024 - 1, 'copper'],
      [1_500 * 1024, 'silver'],
      [12_000 * 1024 - 1, 'silver'],
      [12_000 * 1024, 'gold'],
      [100_000 * 1024 - 1, 'gold'],
      [100_000 * 1024, 'uranium'],
      [10 ** 12, 'uranium']
    ]
    for (const [n, tier] of cases) expect(tierFor(bytes(n), DEFAULT_TIER_THRESHOLDS)).toBe(tier)
  })

  it('[INV-05] the defaults print the 06 §4.1 table, Bronze first', () => {
    expect(DEFAULT_TIER_THRESHOLDS).toEqual([
      { tier: 'bronze', minKb: 0, maxKb: 349 },
      { tier: 'copper', minKb: 350, maxKb: 1_499 },
      { tier: 'silver', minKb: 1_500, maxKb: 11_999 },
      { tier: 'gold', minKb: 12_000, maxKb: 99_999 },
      { tier: 'uranium', minKb: 100_000, maxKb: null }
    ])
  })

  it('[INV-05] a valid override moves its boundary', () => {
    const { thresholds, rejected } = tierThresholdsFrom({
      TIER_COPPER_KB: '10',
      TIER_URANIUM_KB: ' 200000 '
    })
    expect(rejected).toEqual([])
    expect(tierFor(bytes(10 * 1024 - 1), thresholds)).toBe('bronze')
    expect(tierFor(bytes(10 * 1024), thresholds)).toBe('copper')
    expect(tierFor(bytes(100_000 * 1024), thresholds)).toBe('gold')
    expect(tierFor(bytes(200_000 * 1024), thresholds)).toBe('uranium')
    expect(thresholds[0]).toEqual({ tier: 'bronze', minKb: 0, maxKb: 9 })
  })

  it('[INV-05] an invalid override falls back to the default threshold', () => {
    for (const raw of ['', 'abc', '0', '-5', '1.5', '1e3', 'Infinity']) {
      const { thresholds, rejected } = tierThresholdsFrom({ TIER_SILVER_KB: raw })
      expect(thresholds).toEqual(DEFAULT_TIER_THRESHOLDS)
      expect(rejected).toEqual(raw === '' ? [] : ['TIER_SILVER_KB'])
    }
    // Overrides that break the Bronze → Uranium order are all set aside: the defaults stand.
    const disordered = tierThresholdsFrom({ TIER_COPPER_KB: '2000', TIER_GOLD_KB: '13000' })
    expect(disordered.thresholds).toEqual(DEFAULT_TIER_THRESHOLDS)
    expect(disordered.rejected).toEqual(['TIER_COPPER_KB', 'TIER_GOLD_KB'])
    // Unrelated keys are not overrides.
    expect(tierThresholdsFrom({ PATH: '/bin', TIER_CACHE_TTL_S: '5' })).toEqual({
      thresholds: DEFAULT_TIER_THRESHOLDS,
      rejected: []
    })
  })

  it('[INV-05] a source weight that is not a whole non-negative byte count is a programming error', () => {
    for (const n of [-1, 1.5, Number.NaN]) {
      expect(() => tierFor(bytes(n), DEFAULT_TIER_THRESHOLDS)).toThrow(HostInvariantError)
    }
  })
})
