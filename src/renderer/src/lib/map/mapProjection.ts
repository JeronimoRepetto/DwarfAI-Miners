/**
 * Mapping a point authored ON the world map onto the box that renders it.
 *
 * ## A third convention, and why it is not the first one
 *
 * `.claude/rules/coordinates.md` names two coordinate spaces already living in
 * this repository: the old valley map's **box percent** (a percentage of the
 * rendered box, used raw) and the cave's **image percent** (a percentage of the
 * painting, projected at render time). This module puts the world map into the
 * second camp, which is a change of side.
 *
 * Box percent was defensible for thirteen hand-authored sites: they were
 * anchored to broad landforms, kept inside a conservative central band, and the
 * crop could only ever pull them further into the open valley. None of that
 * survives the design's map. Its 74 spawn points are MEASURED positions on the
 * painting — a specific ledge, a specific river fork — spread across image x
 * 3.4-96.8 and y 28.3-98.6, with the closest pair 2.65 apart. A point like that
 * is not "roughly on the near apron"; it either sits on the feature the
 * designer put it on or it does not, and box percent would slide all 74 of them
 * the moment the panel stopped being the shape they were authored at.
 *
 * ## No crop, since #153
 *
 * `screens/map.md` asks for `object-fit: cover`, and the maintainer's first
 * acceptance run overruled it in as many words: "the whole painting must be
 * visible, aspect preserved, no crop — full height of the shell content area,
 * width follows". So the map is fitted the way the mine interior already is —
 * `contain`, centred — and the secondary column's own width is derived from the
 * display's height (see `secondaryColumnWidth` in main/shell/panelBounds.ts) so
 * that the height the painting is drawn at is the whole of the one it is given.
 * Where a display cannot give the column that width, `contain` letterboxes
 * rather than crops, because losing a spawn point off the edge is the failure
 * this correction exists to end.
 *
 * ## Why not sceneGeometry
 *
 * The cave already does this arithmetic, and this is deliberately a second copy
 * rather than a shared one. The two now agree on the fit, but they do not agree
 * on what they are for: this module is authored against the map painting and
 * consumed by `MapView`, `sceneGeometry` against the interior tower. Generalising
 * one function over both would put the map's coordinates inside the cave's
 * module, and the whole point of the coordinate rule is that a reader is never
 * in doubt which space they are standing in. `components/` and `lib/` already
 * carry `map`, `scene` and `vault` as parallel families for the same reason
 * (see src/README.md).
 */

/** A rendered box, in CSS pixels. Only its ratio matters to the maths below. */
export interface MapBoxSize {
  width: number
  height: number
}

/** A point in percent — of the painting going in, of the box coming out. */
export interface MapPoint {
  x: number
  y: number
}

/** The rectangle the painting occupies, in the BOX's own percent space. */
export interface MapDrawnRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

const WHOLE_BOX: MapDrawnRect = { x0: 0, y0: 0, x1: 100, y1: 100 }

function unmeasured(box: MapBoxSize, image: MapBoxSize): boolean {
  return box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0
}

/**
 * How much bigger or smaller than life the painting is drawn in this box —
 * whichever axis `contain` had to shrink further, so the whole painting fits.
 *
 * Zero for an unmeasured box, so a caller can test it as falsy rather than
 * guarding against Infinity.
 */
export function mapFitScale(box: MapBoxSize, image: MapBoxSize): number {
  if (unmeasured(box, image)) return 0
  return Math.min(box.width / image.width, box.height / image.height)
}

/**
 * Where the painting is drawn inside its box, under
 * `object-fit: contain; object-position: 50% 50%`.
 *
 * `contain` scales the art until it fits BOTH axes, so exactly one axis is
 * spent in full and the other letterboxes symmetrically. A box wider than the
 * painting's ratio spends its whole height — the acceptance ruling's own words —
 * and leaves equal margins left and right; a narrower one spends its whole width
 * and leaves equal bands above and below.
 *
 * An unmeasured box — the first render, before a ResizeObserver has reported —
 * reports the whole box, which makes projection the identity and leaves the
 * authored coordinates in charge until a real measurement arrives.
 */
export function drawnMapRect(box: MapBoxSize, image: MapBoxSize): MapDrawnRect {
  const scale = mapFitScale(box, image)
  if (scale <= 0) return { ...WHOLE_BOX }
  const width = ((image.width * scale) / box.width) * 100
  const height = ((image.height * scale) / box.height) * 100
  return {
    x0: (100 - width) / 2,
    y0: (100 - height) / 2,
    x1: (100 + width) / 2,
    y1: (100 + height) / 2
  }
}

/**
 * Project a point authored in image percent into the box's own percent space.
 *
 * Nothing can leave the box any more: under `contain` the whole painting is
 * drawn, so every authored point lands inside 0-100 at every shape. That is the
 * correction (#153), and it is why the "off the visible painting" reading this
 * used to support is gone. `clampToMapBox` stays for a different reason — the
 * marker's own half-width, which can still hang over an edge.
 */
export function projectToMapBox(point: MapPoint, box: MapBoxSize, image: MapBoxSize): MapPoint {
  // Returned untouched rather than run through the whole-box rect, which is the
  // same answer but not the same number: dividing by 100 and multiplying by 100
  // moves 31.92 to 31.920000000000005, and the first render is exactly when a
  // marker's position is compared against the authored value.
  if (unmeasured(box, image)) return { x: point.x, y: point.y }
  const rect = drawnMapRect(box, image)
  return {
    x: rect.x0 + (point.x / 100) * (rect.x1 - rect.x0),
    y: rect.y0 + (point.y / 100) * (rect.y1 - rect.y0)
  }
}

/**
 * Hold a projected point inside the box, leaving a margin for the marker's own
 * width and height.
 *
 * Nothing is cropped since #153, so no spawn point can leave the box on its
 * own. What can still hang over an edge is the MARKER: it is 22px of hit box
 * centred on a point that may sit at image x 3.4 or 96.8, so half of it would
 * be off the panel. A marker held at the edge is a pixel or two out of place and
 * readable; a marker off the edge is a live project the user cannot see.
 */
export function clampToMapBox(point: MapPoint, marginX: number, marginY: number): MapPoint {
  return {
    x: Math.min(Math.max(point.x, marginX), 100 - marginX),
    y: Math.min(Math.max(point.y, marginY), 100 - marginY)
  }
}
