/*
 * The redesigned select's options and what they decide (#635): its classes, its option list and
 * the value it shows. `components.md` ("Select") is the source: a wood face over the native
 * <select>, which keeps the platform's keyboard and screen-reader behaviour. The component draws;
 * this decides.
 */

/** A look forced without the pointer or the keyboard, as the UI kit's own states show it. */
export type SelectState = 'hover' | 'focus'

/** An option is a plain string, its own value and label, or a value with a label. */
export type SelectOption = string | { value: string; label: string }

export interface SelectOptions {
  options: readonly SelectOption[]
  value?: string
  /** The accessible name. */
  label?: string
  disabled?: boolean
  state?: SelectState
}

// Class order follows the kit's: the select, the recipe, then the states.
export function selectClasses(options: SelectOptions): string[] {
  const classes = ['dm-select', 'm-mat']
  if (options.disabled) classes.push('is-disabled')
  if (options.state) classes.push('is-' + options.state)
  return classes
}

export function selectOptions(
  options: readonly SelectOption[]
): { value: string; label: string }[] {
  return options.map((option) =>
    typeof option === 'string' ? { value: option, label: option } : { ...option }
  )
}

// The value asked for when an option carries it, else the first option, which is what a native
// select shows for a value it does not hold.
export function selectedValue(options: SelectOptions): string {
  const list = selectOptions(options.options)
  if (list.some((option) => option.value === options.value)) return options.value!
  return list[0]?.value ?? ''
}
