/*
 * The redesigned badge and pill (#635), `atoms/badge` in the design: a badge counts something
 * waiting on a corner, a pill names one state in a line. Neither is interactive. `components.md`
 * ("Badge and pill") is the source; the components draw, this decides.
 */

/** Attention is the brass default; info and danger repaint the plate. */
export type BadgeTone = 'attn' | 'info' | 'danger'
export type PillTone = 'needs' | 'ok' | 'warn' | 'danger' | 'info'

// The design's overflow state draws a count of 140 as "99+": a corner badge holds two digits.
const BADGE_MAX = 99

export function badgeText(count: number): string {
  return count > BADGE_MAX ? BADGE_MAX + '+' : String(count)
}

export function badgeClasses(tone?: BadgeTone): string[] {
  return tone === undefined || tone === 'attn' ? ['dm-badge'] : ['dm-badge', 'dm-badge--' + tone]
}

export function pillClasses(tone?: PillTone): string[] {
  return tone === undefined ? ['dm-pill'] : ['dm-pill', 'dm-pill--' + tone]
}
