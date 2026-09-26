/*
 * The redesigned slider's options and what they decide (#635): the volume it holds, its readout
 * and its classes. `components.md` ("Slider") is the source: a native 0-100 range named by its
 * label, which the arrow keys move, with the value shown beside it as visible text. The
 * component draws; this decides.
 */

/** A look forced without the pointer, as the UI kit's own state shows it. */
export type SliderState = 'hover'

export interface SliderOptions {
  /** The volume, 0 to 100. */
  value: number
  /** The accessible name ("Music volume"). */
  label: string
  disabled?: boolean
  state?: SliderState
}

// A whole percentage from 0 to 100: the native range's own bounds and step.
export function volume(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

// The readout beside the slider, and the brass fill's extent along the track.
export function sliderReadout(value: number): string {
  return volume(value) + '%'
}

export function sliderClasses(options: SliderOptions): string[] {
  return options.state ? ['dm-slider', 'is-' + options.state] : ['dm-slider']
}
