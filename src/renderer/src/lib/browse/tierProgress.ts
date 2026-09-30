/*
 * What the redesigned tier progress shows (#635), `atoms/progress` in the design: a mine's
 * progress toward its next tier, filled in that tier's colour; a stepped scan while it is still
 * being measured; and "Max tier" in place of a bar at Uranium, which has no next tier. The
 * component draws; this decides.
 */
import { designTierLabel, groupDigits } from '../presentation'
import type { MineTier } from '../../types'

export interface TierProgressOptions {
  value?: number
  max?: number
  /** The tier the fill leads to, which colours it. */
  nextTier?: MineTier
  measuring?: boolean
  /** The mine is at the top tier: no bar, only its value. */
  maxTier?: boolean
  /** The lead-in before the tier's name. */
  label?: string
}

export type TierProgressView =
  | {
      kind: 'toward'
      /** Unset only when no next tier was named: the fill then falls back to brass. */
      tier?: MineTier
      lead: string
      tierLabel: string
      numbers: string
      /** The fill's share of the track, as the `--p` it scales by. */
      fill: string
      bar: { min: 0; max: number; now: number; label: string }
    }
  | { kind: 'measuring'; title: string; numbers: string }
  | { kind: 'max'; title: string; numbers: string }

const share = (value: number, max: number): number =>
  max > 0 ? Math.min(1, Math.max(0, value / max)) : 0

export function tierProgress(options: TierProgressOptions): TierProgressView {
  if (options.measuring) return { kind: 'measuring', title: 'Measuring…', numbers: '—' }
  const value = options.value ?? 0
  if (options.maxTier) return { kind: 'max', title: 'Max tier', numbers: groupDigits(value) }
  const tier = options.nextTier
  const max = options.max ?? 0
  const tierLabel = tier === undefined ? '' : designTierLabel(tier)
  return {
    kind: 'toward',
    ...(tier === undefined ? {} : { tier }),
    lead: options.label ?? 'Next: ',
    tierLabel,
    numbers: groupDigits(value) + ' / ' + groupDigits(max),
    fill: share(value, max).toFixed(3),
    bar: {
      min: 0,
      max,
      now: value,
      label: tier === undefined ? 'Progress' : 'Progress to ' + tierLabel
    }
  }
}
