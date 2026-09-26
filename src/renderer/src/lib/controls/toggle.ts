/*
 * The redesigned toggle's options and what they decide (#635): its classes, its native
 * attributes and the text beside its track. `components.md` ("Toggle") is the source: a
 * <button role="switch"> named by its label, aria-checked saying whether it is on, and a visible
 * On or Off that is secondary to that state. The component draws; this decides.
 */

/** A look forced without the pointer or the keyboard, as the UI kit's own states show it. */
export type ToggleState = 'hover' | 'active' | 'focus'

export interface ToggleOptions {
  on?: boolean
  /** The accessible name; the visible text is only On or Off. */
  label: string
  disabled?: boolean
  state?: ToggleState
}

export interface ToggleAttributes {
  type: 'button'
  role: 'switch'
  'aria-checked': 'true' | 'false'
  'aria-label': string
  disabled: boolean
}

export function toggleClasses(options: ToggleOptions): string[] {
  return options.state ? ['dm-toggle', 'is-' + options.state] : ['dm-toggle']
}

export function toggleAttributes(options: ToggleOptions): ToggleAttributes {
  return {
    type: 'button',
    role: 'switch',
    'aria-checked': options.on ? 'true' : 'false',
    'aria-label': options.label,
    disabled: options.disabled === true
  }
}

export function toggleStateText(on: boolean): 'On' | 'Off' {
  return on ? 'On' : 'Off'
}
