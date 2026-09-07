export const PANEL_MOTION_MS = 250
export const PANEL_MOTION_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

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

export function panelKeyframes(leaving: boolean, vertical: boolean): Keyframe[] {
  const hidden = {
    opacity: 0,
    transform: vertical ? 'translateY(12px)' : 'translateX(var(--panel-motion-x, 12px))'
  }
  const shown = { opacity: 1, transform: 'translate(0, 0)' }
  return leaving ? [shown, hidden] : [hidden, shown]
}
