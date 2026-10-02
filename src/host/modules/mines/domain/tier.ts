// A mine's tier from its measured source weight (06 §4.1, INV-05): never from ore (BR-15).
// Pure: the overrides are read from the environment once at Host start by the composition root
// and passed in here.
import { HostInvariantError } from '../../../kernel/domain/errors'

/** The five tiers in canonical order, poorest first (US-MINES-007). Coal is a material, never a tier. */
export type Tier = 'bronze' | 'copper' | 'silver' | 'gold' | 'uranium'

/** The measured weight of a mine's source files, in bytes (glossary "Score / source weight"). */
export interface SourceWeight {
  readonly bytes: number
}

/** One tier's band in whole KB, as 06 §4.1 prints it: `maxKb` is inclusive, null for the top tier. */
export interface TierThreshold {
  readonly tier: Tier
  readonly minKb: number
  readonly maxKb: number | null
}

/** The five bands, Bronze first, each starting one KB above the previous band's `maxKb`. */
export type TierThresholds = ReadonlyArray<TierThreshold>

/** 1 KB = 1 024 bytes (`tierService.ts:15` at `0bfd108`). */
export const BYTES_PER_KB = 1024

/** The environment variable that overrides each upgrade threshold (`config/config.ts:359-362`). */
export const TIER_THRESHOLD_ENV_KEYS = {
  copper: 'TIER_COPPER_KB',
  silver: 'TIER_SILVER_KB',
  gold: 'TIER_GOLD_KB',
  uranium: 'TIER_URANIUM_KB'
} as const

type UpgradeTier = keyof typeof TIER_THRESHOLD_ENV_KEYS
type UpgradeMinimums = Readonly<Record<UpgradeTier, number>>

const UPGRADE_TIERS: readonly UpgradeTier[] = ['copper', 'silver', 'gold', 'uranium']

const DEFAULT_MINIMUMS: UpgradeMinimums = {
  copper: 350,
  silver: 1_500,
  gold: 12_000,
  uranium: 100_000
}

/** Bronze below 350 KB, Copper from 350, Silver from 1 500, Gold from 12 000, Uranium from 100 000. */
export const DEFAULT_TIER_THRESHOLDS: TierThresholds = bandsOf(DEFAULT_MINIMUMS)

/**
 * The thresholds with the environment's overrides applied (`TIER_COPPER_KB` … `TIER_URANIUM_KB`).
 * An override must be a whole number of KB, at least 1; any other value falls back to its default
 * and is named in `rejected` (for the caller's warning log). Overrides that would break the
 * Bronze → Uranium order are all set aside, so the defaults stand. Other keys are ignored.
 */
export function tierThresholdsFrom(overrides: Readonly<Record<string, string | undefined>>): {
  readonly thresholds: TierThresholds
  readonly rejected: readonly string[]
} {
  const minimums: Record<UpgradeTier, number> = { ...DEFAULT_MINIMUMS }
  const accepted: string[] = []
  const rejected: string[] = []
  for (const tier of UPGRADE_TIERS) {
    const key = TIER_THRESHOLD_ENV_KEYS[tier]
    const raw = overrides[key]?.trim()
    if (raw === undefined || raw === '') continue
    const kb = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    if (Number.isSafeInteger(kb) && kb >= 1) {
      minimums[tier] = kb
      accepted.push(key)
    } else {
      rejected.push(key)
    }
  }
  const ordered = UPGRADE_TIERS.every(
    (tier, index) => index === 0 || minimums[tier] > minimums[UPGRADE_TIERS[index - 1]!]
  )
  if (!ordered)
    return {
      thresholds: DEFAULT_TIER_THRESHOLDS,
      rejected: [...accepted, ...rejected].sort(byKeyOrder)
    }
  return { thresholds: bandsOf(minimums), rejected }
}

/**
 * The tier of a source weight (INV-05): the richest band whose `minKb` (in bytes, 1 KB = 1 024)
 * the weight reaches. A weight that is not a whole, non-negative byte count is a programming error.
 */
export function tierFor(weight: SourceWeight, thresholds: TierThresholds): Tier {
  if (!Number.isSafeInteger(weight.bytes) || weight.bytes < 0) {
    throw new HostInvariantError('tierFor needs a whole, non-negative byte count')
  }
  let tier: Tier | null = null
  for (const band of thresholds) {
    if (weight.bytes >= band.minKb * BYTES_PER_KB) tier = band.tier
  }
  if (tier === null) throw new HostInvariantError('tierFor needs a band starting at 0 KB')
  return tier
}

function bandsOf(minimums: UpgradeMinimums): TierThresholds {
  return [
    { tier: 'bronze', minKb: 0, maxKb: minimums.copper - 1 },
    { tier: 'copper', minKb: minimums.copper, maxKb: minimums.silver - 1 },
    { tier: 'silver', minKb: minimums.silver, maxKb: minimums.gold - 1 },
    { tier: 'gold', minKb: minimums.gold, maxKb: minimums.uranium - 1 },
    { tier: 'uranium', minKb: minimums.uranium, maxKb: null }
  ]
}

function byKeyOrder(a: string, b: string): number {
  const order: readonly string[] = UPGRADE_TIERS.map((tier) => TIER_THRESHOLD_ENV_KEYS[tier])
  return order.indexOf(a) - order.indexOf(b)
}
