/*
 * The redesigned input's options and what they decide (#635): its classes, its native control's
 * attributes, when the search clear shows and what Esc does. `components.md` ("Input") is the
 * source: a parchment well wrapped in a <label>, the native control inside it. The component
 * draws; this decides.
 */

/** A look forced without the pointer or the keyboard, as the UI kit's own states show it. */
export type FieldState = 'hover' | 'focus'

export interface InputOptions {
  placeholder?: string
  value?: string
  /** A search field: the search glyph before the control, a clear button after it. */
  search?: boolean
  /** A textarea in the talk face instead of a one-line input. */
  area?: boolean
  rows?: number
  /** The accessible name; the placeholder names the control when this is absent. */
  label?: string
  disabled?: boolean
  /** Marks the control aria-invalid, beside the danger edge. */
  invalid?: boolean
  /** The id of the hint that describes the control, such as the error saying why it is invalid. */
  describedBy?: string
  /** The native input type; a search field is always `search`. */
  type?: string
  state?: FieldState
}

export interface FieldControlAttributes {
  type?: string
  placeholder: string
  rows?: number
  'aria-label'?: string
  'aria-invalid'?: 'true'
  'aria-describedby'?: string
  disabled: boolean
}

// Class order follows the kit's: the field, the recipe, the variant, then the states.
export function fieldClasses(options: InputOptions): string[] {
  const classes = ['dm-field', 'm-mat']
  if (options.area) classes.push('dm-field--area')
  if (options.invalid) classes.push('is-invalid')
  if (options.disabled) classes.push('is-disabled')
  if (options.state) classes.push('is-' + options.state)
  return classes
}

export function fieldControlAttributes(options: InputOptions): FieldControlAttributes {
  const attributes: FieldControlAttributes = options.area
    ? { placeholder: options.placeholder ?? '', rows: options.rows ?? 2, disabled: false }
    : {
        type: options.search ? 'search' : (options.type ?? 'text'),
        placeholder: options.placeholder ?? '',
        disabled: false
      }
  // The name comes from the label, falling back to the placeholder; an empty one names nothing.
  const name = options.label || options.placeholder
  if (name) attributes['aria-label'] = name
  // The design lead's ruling on the atoms questions (3): an invalid input carries aria-invalid, and
  // aria-describedby points at its hint, the hint being a sibling of the field.
  if (options.invalid) attributes['aria-invalid'] = 'true'
  if (options.describedBy) attributes['aria-describedby'] = options.describedBy
  attributes.disabled = options.disabled === true
  return attributes
}

// A search field shows its clear button once it has text; no other field has one.
export function showsClear(options: InputOptions, value: string): boolean {
  return options.search === true && value !== ''
}

/**
 * Esc inside a search with text clears it and goes no further; only then, on an empty search or
 * any other field, does it bubble to close the layer.
 */
export function escapeAction(options: InputOptions, value: string): 'clear' | 'bubble' {
  return showsClear(options, value) ? 'clear' : 'bubble'
}
