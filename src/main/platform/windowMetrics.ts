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
 * wide, which is a left/right asymmetry rather than a rounding. Asking for the
 * floor makes a left-docked window the same window as a right-docked one.
 */
const WIN32_MIN_WINDOW_WIDTH = 32

/**
 * macOS and Linux: UNMEASURED (#465). 20 is what these platforms were asked
 * for while the closed rail was the narrowest window the app made. The rail is
 * gone since #635 and every composition of the Panel is far wider, so this now
 * bounds only a message panel squeezed beside a shell that fills its display,
 * and a Panel on a display whose scale would shrink it below the floor.
 *
 * The Windows number was applied on every platform until #465, and a floor
 * wider than the window asked for leaves a transparent gutter that macOS draws
 * its own shadow around. The measurement that settles it, on the Mac: create a
 * frameless transparent BrowserWindow with `width: 20` and read
 * `getBounds().width` back. Anything above 20 is this platform's real floor and
 * belongs here, with the same note the Windows one carries.
 */
const UNMEASURED_MIN_WINDOW_WIDTH = 20

/**
 * The narrowest window this platform will actually make, in real pixels.
 *
 * Defaults to the running OS the way every other port in this directory does,
 * so production callers stay clean and a test names the platform it means.
 */
export function minWindowWidth(platform: Platform = currentPlatform()): number {
  return platform === 'win32' ? WIN32_MIN_WINDOW_WIDTH : UNMEASURED_MIN_WINDOW_WIDTH
}
