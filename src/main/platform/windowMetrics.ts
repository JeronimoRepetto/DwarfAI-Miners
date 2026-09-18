/**
 * The floor a platform puts under a window's own width (#465).
 *
 * Here rather than beside the widths it constrains, for the reason
 * `screenArea.ts` is here: `shell/panelBounds.ts` is pure arithmetic whose every
 * edge has to be assertable for macOS and Linux from a Windows host, so the one
 * number in it that differs per OS cannot be a constant that file reads. It is
 * an answer this module gives for a platform the caller names.
 */
import { currentPlatform, type Platform } from './platform'

/**
 * Windows, MEASURED (#153): a BrowserWindow asked for 20px comes back 32px
 * wide, which is a left/right asymmetry rather than a rounding — a right-docked
 * rail's extra twelve pixels hang off the screen and it still looks like the
 * design's 20px rail, a left-docked one's do not and it comes out fat. Asking
 * for the floor makes both edges the same window; the renderer draws the
 * design's 20px rail against the docked side of it and leaves the rest clear.
 */
const WIN32_MIN_WINDOW_WIDTH = 32

/**
 * macOS and Linux: UNMEASURED, and this is the design's rail rather than a
 * floor anybody has walked (#465).
 *
 * The Windows number was applied on every platform until this issue, so a Mac
 * asked for a window twelve pixels wider than the rail it paints into it and
 * left the difference transparent — which is the rectangle the OS then drew its
 * own shadow around, sticking out past the bar the maintainer was looking at.
 * A floor equal to the rail cannot produce that gutter; whether the platform
 * honours it is the part still owed.
 *
 * The measurement that settles it, on the Mac: create a frameless transparent
 * BrowserWindow with `width: 20` and read `getBounds().width` back. Anything
 * above 20 is this platform's real floor and belongs here in place of the
 * design's number, with the same note the Windows one carries.
 *
 * A deliberate copy of `RAIL_WIDTH` (`shell/panelBounds.ts`), which this layer
 * must not import — `windowMetrics.test.ts` holds the two equal so they cannot
 * drift.
 */
const RAIL_MIN_WINDOW_WIDTH = 20

/**
 * The narrowest window this platform will actually make, in real pixels.
 *
 * Defaults to the running OS the way every other port in this directory does,
 * so production callers stay clean and a test names the platform it means.
 */
export function minWindowWidth(platform: Platform = currentPlatform()): number {
  return platform === 'win32' ? WIN32_MIN_WINDOW_WIDTH : RAIL_MIN_WINDOW_WIDTH
}
