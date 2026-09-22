import type { DOMKeyframesDefinition, Easing } from 'motion-v'

export const PANEL_MOTION_MS = 250
/**
 * The same curve WAAPI took as the CSS string `cubic-bezier(0.2, 0, 0, 1)`, in
 * the shape motion-v's `Easing` accepts: a cubic-bezier is a four-number array
 * rather than a string here.
 */
export const PANEL_MOTION_EASE: Easing = [0.2, 0, 0, 1]

/**
 * Two deadlines behind the 250ms, because `animation.finished` is not a promise
 * of completion (#266).
 *
 * Web Animations run on the DOCUMENT timeline, and Chromium freezes it for a
 * window it considers hidden — which on Windows includes one another program
 * has occluded, since `backgroundThrottling` is on by default. The compositor
 * still lands the last frame, so the leaving column reaches opacity 0 while the
 * main thread never resolves `finished`. The panel is then drawn as its widest
 * composition, painting the amber ground, with every column inside it invisible
 * and awaiting a `done()` that never comes: the entirely yellow frame the issue
 * photographed, at the size the window had before the shrink.
 *
 * So a leave gets `PANEL_MOTION_WATCHDOG_MS` to report itself and is released
 * anyway after that, and the layout queue waits no longer than
 * `PANEL_LEAVE_BOUND_MS` — one margin past the watchdog, so an honest leave
 * always reports before the queue stops listening. Neither changes the 250ms a
 * focused window animates for (#164); they only bound what may follow it.
 */
export const PANEL_MOTION_WATCHDOG_MS = PANEL_MOTION_MS + 50
export const PANEL_LEAVE_BOUND_MS = PANEL_MOTION_WATCHDOG_MS + 50

/**
 * The vertical hidden offset every rising or leaving panel starts or ends at,
 * in CSS pixels — read off by `MessagePanelWindow`, which holds the surface at
 * this same keyframe between reports rather than running a motion to get
 * there (see `holdHidden`).
 */
export const PANEL_MOTION_Y = 12

/**
 * The horizontal offset a panel rises from or leaves toward, read off the
 * element rather than named here — `horizontalOffsetPx` on `panelKeyframes`.
 *
 * WAAPI resolved `translateX(var(--panel-motion-x, 12px))` off the live CSS
 * cascade every frame it played, so `.shell.edge-left` (App.vue) flipping that
 * custom property's sign for a left-docked shell was invisible to this file —
 * the browser did the mirroring, continuously, for free. motion-v drives `x`
 * as a plain number decided once rather than an expression it can defer to
 * the cascade, so the sign has to be read here instead, before the keyframes
 * are built. The browser still decides it; only earlier than it used to.
 */
export function panelMotionX(element: Element): number {
  const raw = getComputedStyle(element).getPropertyValue('--panel-motion-x')
  const parsed = parseFloat(raw)
  return Number.isNaN(parsed) ? 12 : parsed
}

/**
 * The motion-v shape for a panel rising into or leaving the shell: opacity and
 * one axis, each running hidden-to-shown or the reverse. `horizontalOffsetPx`
 * defaults to the WAAPI custom property's own default (12px, unmirrored) —
 * pass `panelMotionX(element)` for a horizontal caller to carry a left-docked
 * shell's mirrored sign through; a vertical caller never reads it.
 */
export function panelKeyframes(
  leaving: boolean,
  vertical: boolean,
  horizontalOffsetPx = 12
): DOMKeyframesDefinition {
  const opacity: [number, number] = leaving ? [1, 0] : [0, 1]
  if (vertical) return { opacity, y: leaving ? [0, PANEL_MOTION_Y] : [PANEL_MOTION_Y, 0] }
  return { opacity, x: leaving ? [0, horizontalOffsetPx] : [horizontalOffsetPx, 0] }
}
