// The window an open Veta overlay grows to (ADR-025 item 2; 07 N-25; 14 §3.9 `VetaLayoutRequest {kind:'overlay'}`;
// ISSUE-288). Pure; shared by UI main, which places the window, and the Veta renderer, which lays the island and the
// overlay out inside it, so the two agree and the island never moves on the screen.
//
// The overlay (the grip menu, the mine picker; its `width` × `height` include its gap to the island) sits beside the
// island on the screen side, away from the docked edge (DS/docs/screens/veta.md: menus open toward the screen), and
// both are aligned to the island's anchored end, as the prototype's grip menu aligns (`align: end` at the end, `start`
// at the start). The window is the box around the two: as long as the longer of them along the edge, the island's
// thickness plus the overlay's depth across it.
import type { VetaDock } from './windowApi'

/** The grown window's size, and where the island and the overlay sit inside it, in CSS pixels. */
export interface VetaOverlayFrame {
  width: number
  height: number
  island: { x: number; y: number }
  overlay: { x: number; y: number }
}

/** The frame for an island of `length` × `thickness` docked at `dock`, with an overlay of `width` × `height` open. */
export function vetaOverlayFrame(
  dock: Pick<VetaDock, 'edge' | 'end'>,
  island: { length: number; thickness: number },
  overlay: { width: number; height: number }
): VetaOverlayFrame {
  const vertical = dock.edge === 'left' || dock.edge === 'right'
  // Along the edge: the overlay's extent there, and the window's.
  const overlayAlong = vertical ? overlay.height : overlay.width
  const overlayAcross = vertical ? overlay.width : overlay.height
  const along = Math.max(island.length, overlayAlong)
  const islandAlong = dock.end === 'end' ? along - island.length : 0
  const overlayAt = dock.end === 'end' ? along - overlayAlong : 0
  // Across the edge: the island against the edge, the overlay on the screen side of it.
  const edgeFirst = dock.edge === 'top' || dock.edge === 'left'
  const islandAcross = edgeFirst ? 0 : overlayAcross
  const overlayAcrossAt = edgeFirst ? island.thickness : 0
  const across = island.thickness + overlayAcross
  return vertical
    ? {
        width: across,
        height: along,
        island: { x: islandAcross, y: islandAlong },
        overlay: { x: overlayAcrossAt, y: overlayAt }
      }
    : {
        width: along,
        height: across,
        island: { x: islandAlong, y: islandAcross },
        overlay: { x: overlayAt, y: overlayAcrossAt }
      }
}
