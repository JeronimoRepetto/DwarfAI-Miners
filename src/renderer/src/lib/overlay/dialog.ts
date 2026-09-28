/*
 * The dialog's options and what they decide (#635), `molecules/dialog` in the design: a raised
 * card, a title, a body, Cancel then the action. Typed confirmation asks for a word first and keeps
 * its action disabled until the field holds it, trimmed and in any case. Tab is trapped inside and
 * wraps. The component draws; this decides.
 */

/** One button of a dialog's actions row, in order: Cancel first. */
export interface DialogAction {
  label: string
  variant?: 'primary' | 'danger'
  disabled?: boolean
  /** Held disabled until a typed confirmation matches. */
  confirms?: boolean
}

export interface DialogOptions {
  danger?: boolean
  /** The wide card, 520px: the tier explainer. */
  wide?: boolean
  /** Drawn in place with no scrim, as the UI kit's own states draw it. */
  static?: boolean
}

// Class order follows the kit's: the card, its recipe, then the variants.
export function dialogClasses(options: DialogOptions): string[] {
  const classes = ['dm-dialog', 'm-mat', 'm-raised']
  if (options.danger) classes.push('dm-dialog--danger')
  if (options.wide) classes.push('dm-dialog--wide')
  if (options.static) classes.push('dm-dialog--static')
  return classes
}

export const typedPrompt = (word: string): string => 'Type "' + word + '" to confirm'
export const typedPlaceholder = (word: string): string => 'Type "' + word + '"'

export function typedMatches(value: string, word: string): boolean {
  return value.trim().toLowerCase() === word.toLowerCase()
}

/**
 * Where Tab moves the focus among a dialog's `count` controls from `current` (-1 when the focus is
 * not inside it): forward or, with Shift, back, wrapping at both ends so it never leaves.
 */
export function trapTab(count: number, current: number, back: boolean): number | undefined {
  if (count === 0) return undefined
  if (current < 0) return back ? count - 1 : 0
  return (current + (back ? -1 : 1) + count) % count
}
