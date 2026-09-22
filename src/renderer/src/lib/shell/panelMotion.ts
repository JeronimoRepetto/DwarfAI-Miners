import type { DOMKeyframesDefinition } from 'motion-v'
import { WATCHDOG_MARGIN_MS, motionBoundMs } from './motionTiming'

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

/**
 * The bound a whole SHRINK is willing to wait on its slowest leave (#266):
 * `usePanelLayout.boundedLeave`'s own race, and `useShellFold`'s `overrun`
 * timer for the window catching up with a fold — both are the layout queue's
 * own floor under a leave that never reports, never a single run's watchdog.
 *
 * One margin further than that per-run watchdog (`motionBoundMs`, armed
 * fresh by `boundedMotion.run` for whatever keyframes THAT run is actually
 * animating): the run's own watchdog is what ends an honest leave that has
 * stopped reporting, and the queue has to always outlast it, or the shrink
 * could fire before that leave's own watchdog ever had its say. Was a literal
 * 350ms (`PANEL_MOTION_MS` 250 + two 50ms margins); the run's own duration is
 * derived now, so this derives from it too rather than re-stating a number
 * that would silently go stale the moment motion-dom's own defaults do.
 *
 * Derived from the SLOWEST leave the shell can run: a horizontal panel
 * leaving the fixed 12px offset `panelMotionX`'s own unmirrored default
 * names (every panel leave in this app travels exactly that, sign aside —
 * `panelMotionX` only ever mirrors it for a left-docked shell, never changes
 * its magnitude) — so a vertical leave, which fades the same 12px on `y`, or
 * any leave with a genuinely smaller offset, is always inside this bound
 * rather than merely usually.
 */
export function panelLeaveBoundMs(): number {
  return motionBoundMs(panelKeyframes(true, false, 12)) + WATCHDOG_MARGIN_MS
}
