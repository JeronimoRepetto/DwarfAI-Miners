/*
 * The redesigned map marker's options and what they decide (#635), `atoms/marker` in the design:
 * a mine on the map as a tier hexagon, a <button> named "<Tier> mine" or its label, pressed while
 * its mine is open, and the "?" when a dwarf there needs you (attention level 1 on the map). The
 * caller places it in image percent and it centres itself on that point; nothing here positions
 * it. The component draws; this decides.
 */
import { designTierLabel } from '../presentation'
import type { MineTier } from '../../types'

/** A look forced without the pointer or the keyboard, as the UI kit's own states show it. */
export type TierMarkerState = 'hover' | 'active' | 'focus'

export interface TierMarkerOptions {
  tier: MineTier
  /** A dwarf there needs you. */
  asking?: boolean
  /** The accessible name, in place of "<Tier> mine". */
  label?: string
  /** Its mine is open. */
  selected?: boolean
  state?: TierMarkerState
}

export interface TierMarkerAttributes {
  type: 'button'
  'data-tier': MineTier
  'aria-label': string
  'aria-pressed'?: 'true'
}

export function tierMarkerClasses(options: TierMarkerOptions): string[] {
  const classes = ['dm-marker']
  if (options.asking) classes.push('dm-marker--ask')
  if (options.state) classes.push('is-' + options.state)
  return classes
}

// The design states aria-pressed only on the open marker, not "false" on every other one.
export function tierMarkerAttributes(options: TierMarkerOptions): TierMarkerAttributes {
  const attributes: TierMarkerAttributes = {
    type: 'button',
    'data-tier': options.tier,
    'aria-label': options.label ?? designTierLabel(options.tier) + ' mine'
  }
  if (options.selected) attributes['aria-pressed'] = 'true'
  return attributes
}
