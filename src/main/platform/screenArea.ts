/**
 * Which part of a display the docked shell is allowed to cover (#90).
 *
 * This is the whole per-OS story of the redesigned window, and it lives here
 * rather than inside the window because the rest of the shell must not know an
 * operating system: `panelBounds.ts` takes the rectangle this returns and does
 * pure arithmetic on it, so every edge, width and clamp is assertable for macOS
 * and Linux from a Windows host.
 *
 * Until #238 the platform argument actually branched the answer; a real Mac
 * showed that branch was wrong, so read `panelScreenArea`'s own comment below
 * before assuming this file still treats macOS or Linux as a special case.
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
 * The rectangle the panel may span on this display: `workArea`, on every
 * platform (#238).
 *
 * This used to return `bounds` unchanged on macOS and Linux, on the strength
 * of the design's own instruction — the closed rail's taskbar reservation was
 * called out as Windows-only, and the source said so twice, so inventing a
 * matching reservation elsewhere would have contradicted a spec that went out
 * of its way to rule it out. That reading was never checked on a real Mac.
 * #238 did: the shell spanned the whole display height there, and its own
 * bottom controls — the Add panel, the Message panel — landed behind the
 * Dock, unclickable. The Dock is exactly the reservation `workArea` exists
 * for; the design's silence meant nobody had walked a real Mac yet to notice
 * that, not that none was needed.
 *
 * `workArea` is the right default on Linux too, unverified but for the same
 * reason: a GNOME top bar or a bottom dock reserves screen the same way a
 * Windows taskbar or a macOS Dock does, and asking the OS what it reserved
 * beats assuming that nothing was.
 *
 * One piece of the old rule survives: the closed rail never needed an extra
 * WIDTH reservation on macOS or Linux, and it still doesn't — `workArea`
 * already leaves width alone unless the OS itself has docked something to a
 * side. There was never a real conflict between "no width adjustment" and
 * "take the OS's own rectangle"; the old code just answered a wider question
 * (the whole rectangle) than the design had actually settled (the width).
 *
 * Downstream, `uiScale` (`panelBounds.ts`) derives its zoom from this
 * rectangle's height, so losing the Dock's strip shrinks the panel slightly on
 * macOS. That is the fix working, not a regression — #198 is where the
 * resulting typography size gets weighed, not here.
 *
 * `platform` stays in the signature though nothing here branches on it
 * anymore: every caller already has one to hand (`window.ts` computes
 * `currentPlatform()` for this exact call), and `screenArea.test.ts` still
 * exercises darwin/linux/win32 side by side so a future change that treats one
 * of them differently again gets caught here — the one place this file's
 * per-OS story is supposed to live — rather than downstream in
 * `panelBounds.ts`'s platform-blind arithmetic.
 */
export function panelScreenArea(display: DisplayAreas, _platform: Platform): ScreenRect {
  return display.workArea
}
