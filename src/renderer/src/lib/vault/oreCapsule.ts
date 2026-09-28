/*
 * What the redesigned ore capsule shows (#635), `atoms/ore` in the design: one material and its
 * own count, in units of that material. Never a total, never converted, never summed across
 * materials (vault.ts): each capsule is one counter. The count compacts from ten thousand up and
 * the capsule's name always carries it in full. The component draws; this decides.
 */
import { groupDigits, materialLabel } from '../presentation'
import type { Material } from '../../types'

const COMPACT_FROM = 10_000

/*
 * One decimal place below `wholeFrom` of the unit, dropped when it is zero ("12.5K", "10K"); from
 * there up, whole ("281K"). Thousands keep their decimal to 99.9K, millions only to 9.9M (the
 * design lead's ruling, 2026-09-26). The decimal is judged on the rounded figure, so 99,960 reads
 * "100K" rather than "100.0K".
 */
function scaled(value: number, at: number, wholeFrom: number): number {
  const v = value / at
  const tenths = Number(v.toFixed(1))
  return tenths < wholeFrom ? tenths : Math.round(v)
}

export function compactUnits(units: number): string {
  const value = Math.max(0, Math.trunc(units))
  if (value < COMPACT_FROM) return groupDigits(value)
  const thousands = scaled(value, 1_000, 100)
  // A figure that rounds to a thousand thousands is written as millions instead ("1M", not "1000K").
  if (thousands < 1000) return thousands + 'K'
  return scaled(value, 1_000_000, 10) + 'M'
}

export function oreCapsuleName(material: Material, units: number): string {
  return materialLabel(material) + ': ' + groupDigits(units)
}

/** lg is the vault's larger capsule. */
export type OreCapsuleSize = 'lg'

export function oreCapsuleClasses(units: number, size?: OreCapsuleSize): string[] {
  const classes = ['dm-ore']
  if (size) classes.push('dm-ore--' + size)
  if (units === 0) classes.push('dm-ore--zero')
  return classes
}
