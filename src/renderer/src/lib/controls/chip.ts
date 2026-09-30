/*
 * The redesigned chips' options and what they decide (#635). `components.md` ("Chip") is the
 * source, three parts under one stylesheet: a choice chip is a button that toggles with
 * aria-pressed, or takes role radio with aria-checked inside a radiogroup; a tier chip is the
 * tier word on its -lo ground; a meta chip is a sunken header fact, not pressable. The components
 * draw; this decides.
 */

import type { IconName } from '../icon/iconGrids'
import type { MineTier } from '../../types'

/** A look forced without the pointer or the keyboard, as the UI kit's own states show it. */
export type ChipState = 'hover' | 'active' | 'focus'

export interface ChipOptions {
  label: string
  /** A tier filter: the chip carries the tier, and a gem in its marker colour. */
  tier?: MineTier
  /** Set, either way, only on a chip that toggles; true turns it gold. */
  pressed?: boolean
  /** Inside a radiogroup, a chip is a radio and states aria-checked instead. */
  role?: 'radio'
  /** An icon's registry name, drawn before the label. */
  icon?: IconName
  disabled?: boolean
  state?: ChipState
}

export interface ChipAttributes {
  type: 'button'
  disabled: boolean
  role?: 'radio'
  'data-tier'?: MineTier
  'aria-pressed'?: 'true' | 'false'
  'aria-checked'?: 'true' | 'false'
}

// Class order follows the kit's: the chip, the recipe, then the state.
export function chipClasses(options: ChipOptions): string[] {
  const classes = ['dm-chip', 'm-mat']
  if (options.state) classes.push('is-' + options.state)
  return classes
}

export function chipAttributes(options: ChipOptions): ChipAttributes {
  const attributes: ChipAttributes = { type: 'button', disabled: options.disabled === true }
  if (options.tier !== undefined) attributes['data-tier'] = options.tier
  if (options.role === 'radio') {
    attributes.role = 'radio'
    attributes['aria-checked'] = options.pressed ? 'true' : 'false'
  } else if (options.pressed !== undefined) {
    attributes['aria-pressed'] = options.pressed ? 'true' : 'false'
  }
  return attributes
}

// A meta chip's tooltip: the fact itself unless a title is given, since a long fact is cut with
// an ellipsis and the tooltip is where it reads whole.
export function metaChipTitle(text: string, title?: string): string {
  return title ?? text
}
