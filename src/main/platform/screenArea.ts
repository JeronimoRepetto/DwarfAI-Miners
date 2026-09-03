/**
 * Which part of a display the docked shell is allowed to cover (#90).
 *
 * This is the whole per-OS story of the redesigned window, and it lives here
 * rather than inside the window because the rest of the shell must not know an
 * operating system: `panelBounds.ts` takes the rectangle this returns and does
 * pure arithmetic on it, so every edge, width and clamp is assertable for macOS
 * and Linux from a Windows host.
 */
import type { Platform } from './platform'

/** A screen rectangle in Electron's display coordinates. */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** The two rectangles Electron reports for one display. */
export interface DisplayAreas {
  /** The whole display. */
  bounds: ScreenRect
  /** What is left once the OS has reserved its own furniture. */
  workArea: ScreenRect
}

/**
 * The rectangle the panel may span on this display.
 *
 * Windows is the only platform that gets the reservation, and that is the
 * design's instruction rather than an inference: the closed rail leaves room for
 * the taskbar there, and the source says twice that no equivalent adjustment is
 * required on macOS or Linux. Taking `workArea` everywhere would have been the
 * tidier-looking rule and would contradict a spec that went out of its way to
 * rule it out.
 */
export function panelScreenArea(display: DisplayAreas, platform: Platform): ScreenRect {
  return platform === 'win32' ? display.workArea : display.bounds
}
