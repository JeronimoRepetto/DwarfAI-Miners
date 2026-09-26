/*
 * The redesigned nav slot's options and what they decide (#635), `atoms/slot` in the design: a
 * 40px wood slot in the nav column, a <button> named by its label. The page shown carries
 * aria-current, the music slot is a toggle with aria-pressed, and a needs-you count shows as a
 * badge that only the slot's own name reads out. The component draws; this decides.
 */

import type { IconName } from '../icon/iconGrids'

/** A look forced without the pointer or the keyboard, as the UI kit's own states show it. */
export type NavSlotState = 'hover' | 'active' | 'focus'

export interface NavSlotOptions {
  icon: IconName
  label: string
  /** The page shown. */
  current?: boolean
  /** Set, either way, only on a toggle (the music slot). */
  pressed?: boolean
  /** The needs-you count on its corner; 0 draws no badge. */
  badge?: number
  /** A warning on the slot, such as a shortcut that failed to register. */
  warn?: boolean
  state?: NavSlotState
}

export interface NavSlotAttributes {
  type: 'button'
  'aria-label': string
  /** The label that rises beside the slot, drawn from this attribute by its stylesheet. */
  'data-label': string
  'aria-current'?: 'page'
  'aria-pressed'?: 'true' | 'false'
  'data-warn'?: 'true'
}

export function navSlotClasses(options: NavSlotOptions): string[] {
  const classes = ['dm-slot', 'm-mat']
  if (options.state) classes.push('is-' + options.state)
  return classes
}

// The full count, never the badge's overflowed "99+": the name is where the number reads whole.
export function navSlotName(label: string, badge = 0): string {
  if (badge <= 0) return label
  return label + ', ' + badge + (badge === 1 ? ' needs you' : ' need you')
}

export function navSlotAttributes(options: NavSlotOptions): NavSlotAttributes {
  const attributes: NavSlotAttributes = {
    type: 'button',
    'aria-label': navSlotName(options.label, options.badge),
    'data-label': options.label
  }
  if (options.current) attributes['aria-current'] = 'page'
  if (options.pressed !== undefined) attributes['aria-pressed'] = options.pressed ? 'true' : 'false'
  if (options.warn) attributes['data-warn'] = 'true'
  return attributes
}
