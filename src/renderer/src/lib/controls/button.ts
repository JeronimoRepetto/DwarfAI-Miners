/*
 * The redesigned button's options and what they decide (#635): its classes, its glyph scale and
 * its native attributes. `components.md` ("Button") is the source: one public constructor taking
 * these options, a native <button> underneath. The component draws; this decides.
 */

/** Primary is brass, one per surface; danger stays red and apart; link has no plate. */
export type ButtonVariant = 'primary' | 'danger' | 'link'
/** `sm` shrinks an icon-only button to 32px; `lg` is the 40px launch action. */
export type ButtonSize = 'sm' | 'lg'
/** A look forced without the pointer or the keyboard, as the UI kit's own states show it. */
export type ButtonState = 'hover' | 'active' | 'focus'

export interface ButtonOptions {
  label?: string
  /** An icon's registry name. */
  icon?: string
  iconScale?: 1 | 2
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
  /** Set, either way, only on a toggle: it becomes aria-pressed, and true turns it gold. */
  pressed?: boolean
  disabled?: boolean
  /** The tooltip; on an icon-only button, which must pass one, also its accessible name. */
  title?: string
  haspopup?: 'menu'
  type?: 'button' | 'submit' | 'reset'
  state?: ButtonState
}

export interface ButtonAttributes {
  type: 'button' | 'submit' | 'reset'
  disabled: boolean
  title?: string
  'aria-label'?: string
  'aria-pressed'?: 'true' | 'false'
  'aria-haspopup'?: 'menu'
}

export function isIconOnly(options: ButtonOptions): boolean {
  return options.icon !== undefined && !options.label
}

// Class order follows the kit's: the button, the recipe, variant, size, shape, then the state.
export function buttonClasses(options: ButtonOptions): string[] {
  const classes = ['dm-btn', 'm-mat']
  if (options.variant) classes.push('dm-btn--' + options.variant)
  if (options.size) classes.push('dm-btn--' + options.size)
  if (options.block) classes.push('dm-btn--block')
  if (isIconOnly(options)) classes.push('dm-btn--icon')
  if (options.state) classes.push('is-' + options.state)
  return classes
}

// A glyph alone fills its 36px button at 2x; a small icon-only button and a glyph beside a label
// stay at 1x (16px). Only whole scales keep every pixel square.
export function buttonIconScale(options: ButtonOptions): 1 | 2 {
  if (options.iconScale !== undefined) return options.iconScale
  return isIconOnly(options) && options.size !== 'sm' ? 2 : 1
}

export function buttonAttributes(options: ButtonOptions): ButtonAttributes {
  const attributes: ButtonAttributes = {
    type: options.type ?? 'button',
    disabled: options.disabled === true
  }
  if (options.title !== undefined) attributes.title = options.title
  if (isIconOnly(options) && options.title !== undefined) attributes['aria-label'] = options.title
  if (options.pressed !== undefined) attributes['aria-pressed'] = options.pressed ? 'true' : 'false'
  if (options.haspopup !== undefined) attributes['aria-haspopup'] = options.haspopup
  return attributes
}
