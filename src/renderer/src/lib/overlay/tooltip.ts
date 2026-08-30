/**
 * Placement math for the dwarf hover tooltip. A dwarf standing near the edge
 * of the panel used to clip its tooltip off-screen (unreadable for the
 * foreman parked at the far left); this keeps it fully inside the visible
 * area instead.
 */

/** Width/height of a box, in px. */
export interface TooltipBox {
  width: number
  height: number
}

/** The sprite hit-box the tooltip anchors to, in viewport coordinates (e.g. getBoundingClientRect()). */
export interface TooltipAnchor {
  left: number
  top: number
  width: number
  height: number
}

export type TooltipSide = 'above' | 'below'

export interface TooltipPlacement {
  /** Viewport-relative px, for a `position: fixed` element. */
  left: number
  top: number
  side: TooltipSide
}

/** Minimum gap kept between the tooltip and the panel edge. */
export const TOOLTIP_MARGIN = 6
/** Gap between the tooltip and the sprite it describes. */
export const TOOLTIP_GAP = 6

/**
 * Where to draw the tooltip so it stays fully inside `container` (the
 * visible panel).
 *
 * Horizontally it starts centered on the anchor and is clamped toward
 * whichever edge it would otherwise cross — which reads as a flip once the
 * sprite sits right against that edge, since the tooltip then hugs the edge
 * instead of the sprite's center. Vertically it prefers sitting above the
 * sprite, flipping below when that would clip the top edge.
 */
export function computeTooltipPlacement(
  anchor: TooltipAnchor,
  tooltip: TooltipBox,
  container: TooltipBox,
  margin: number = TOOLTIP_MARGIN,
  gap: number = TOOLTIP_GAP
): TooltipPlacement {
  const centerX = anchor.left + anchor.width / 2
  const maxLeft = Math.max(container.width - tooltip.width - margin, margin)
  const left = Math.min(Math.max(centerX - tooltip.width / 2, margin), maxLeft)

  const aboveTop = anchor.top - gap - tooltip.height
  const side: TooltipSide = aboveTop < margin ? 'below' : 'above'
  const top = side === 'above' ? aboveTop : anchor.top + anchor.height + gap

  return { left, top, side }
}
