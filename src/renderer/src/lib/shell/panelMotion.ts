export const PANEL_MOTION_MS = 250
export const PANEL_MOTION_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

export function panelKeyframes(leaving: boolean, vertical: boolean): Keyframe[] {
  const hidden = {
    opacity: 0,
    transform: vertical ? 'translateY(12px)' : 'translateX(var(--panel-motion-x, 12px))'
  }
  const shown = { opacity: 1, transform: 'translate(0, 0)' }
  return leaving ? [shown, hidden] : [hidden, shown]
}
