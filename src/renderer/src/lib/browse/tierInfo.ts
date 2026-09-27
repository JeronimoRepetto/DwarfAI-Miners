/*
 * What the tier explainer says (#635), `organisms/tier-info` in the design: the five tiers in
 * canonical order with the range of measured weight each covers, then what one unit of each
 * material is worth, then the one invariant a person must know about ore. It merges the two
 * explainers the app had (the Mines page's tier thresholds and the map's materials).
 *
 * The ranges are the app's own thresholds, the ones main classifies a walk against
 * (TIER_WEIGHT_THRESHOLDS_KB). The design's sample data carries different, illustrative floors;
 * they are passed in only where a golden draws the sample. The component draws; this decides.
 */
import {
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  MINE_TIERS,
  TIER_WEIGHT_THRESHOLDS_KB
} from '../../types'
import type { Material, MineTier } from '../../types'
import { groupDigits } from '../presentation'
import { compactUnits } from '../vault/oreCapsule'

export type TierThresholds = typeof TIER_WEIGHT_THRESHOLDS_KB

export const TIER_NOTE = 'Each material is its own counter. They never convert into one another.'

export interface TierRange {
  tier: MineTier
  range: string
}

/** Each tier's range: below the first floor, from one floor to just under the next, then up. */
export function tierRanges(thresholds: TierThresholds = TIER_WEIGHT_THRESHOLDS_KB): TierRange[] {
  const { copperKb, silverKb, goldKb, uraniumKb } = thresholds
  const floors = [0, copperKb, silverKb, goldKb, uraniumKb]
  return MINE_TIERS.map((tier, i) => {
    const floor = floors[i]!
    const next = floors[i + 1]
    const range =
      i === 0
        ? 'below ' + groupDigits(next!)
        : next === undefined
          ? groupDigits(floor) + ' and up'
          : groupDigits(floor) + ' – ' + groupDigits(next - 1)
    return { tier, range }
  })
}

export interface GrainRow {
  material: Material
  text: string
}

/** What one unit of each material is worth in tokens, poorest first: a grain size, never a rate. */
export function grainRows(): GrainRow[] {
  return MATERIALS.map((material) => ({
    material,
    text: '1 = ' + compactUnits(MATERIAL_TOKENS_PER_UNIT[material]) + ' tokens'
  }))
}
