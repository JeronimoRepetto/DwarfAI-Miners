/*
 * Where the Control room's mosaic scrolls to bring a zone into view (07 S39.06, S32.14; ADR-025 item 8; ISSUE-311). Pure.
 *
 * The zone is measured in the mosaic's own content coordinates (its left edge from the mosaic's start, as `scrollLeft`
 * counts). The scroll moves as little as it can: a zone wholly in view moves nothing; one to the left of the viewport
 * lines its left edge up with the viewport's; one to the right lines its right edge up, never past its left edge when
 * the zone is wider than the viewport.
 */

/** The mosaic's viewport: its sideways scroll and its visible width. */
export interface MosaicViewport {
  readonly scrollLeft: number
  readonly width: number
}

/** A zone in the mosaic's content coordinates. */
export interface MosaicZone {
  readonly left: number
  readonly width: number
}

/** The `scrollLeft` that brings `zone` into view, or `null` when it already is. */
export function zoneScrollLeft(viewport: MosaicViewport, zone: MosaicZone): number | null {
  const right = zone.left + zone.width
  if (zone.left >= viewport.scrollLeft && right <= viewport.scrollLeft + viewport.width) return null
  const target =
    zone.left < viewport.scrollLeft ? zone.left : Math.min(zone.left, right - viewport.width)
  return Math.max(0, target)
}
