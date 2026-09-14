import type { MessagePanelSurface } from '../../types'

/**
 * What a change of surface asks the message panel's window to DO (#389).
 *
 * - `enter` — the window is arriving. It was created or re-placed hidden and is
 *   revealed by the first height report, so the surface starts at its hidden
 *   keyframe and rises once that report has gone.
 * - `leave` — the window is going. The surface settles first and main defers
 *   the hide until it has, so nothing is taken off screen mid-frame.
 * - `cut` — neither. The window stays exactly where it is and the surface
 *   inside it is replaced.
 */
export type MessageSurfaceMotion = 'enter' | 'leave' | 'cut'

/**
 * Which of the three a change from `from` to `to` is.
 *
 * ## Why swapping surfaces is a CUT and not a crossfade
 *
 * Both swaps that can happen here are ones a crossfade would damage.
 *
 * Selecting another dwarf while the panel is open gives the new panel its own
 * opening height (see `panelHeight`, and the `:key` remount that makes taking it
 * once true), so main re-places the WINDOW around it. A crossfade would dissolve
 * one panel into another while the rectangle holding both changes size — the
 * resize painted through the motion, which is the very thing the shell's fold
 * exists to stop (#388).
 *
 * And the launch handover is the design's own transition (`components.md`, "Add
 * Panel to MessagePanel transition"): the submitted prompt STAYS on screen and
 * becomes the conversation's first message. Fading the Add Panel out would
 * animate away the one thing that transition is specified to keep.
 *
 * `from` is what the window is currently DRAWING rather than what main last
 * held, so a close whose surface is still leaving reads as the open surface it
 * still shows — see MessagePanelWindow, where that divergence lives.
 */
export function messageSurfaceMotion(
  from: MessagePanelSurface,
  to: MessagePanelSurface
): MessageSurfaceMotion {
  if (from === 'none' && to !== 'none') return 'enter'
  if (from !== 'none' && to === 'none') return 'leave'
  return 'cut'
}
