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
 * ## Why not sceneGeometry
 *
 * The cave already does this arithmetic, and this is deliberately a second copy
 * rather than a shared one. `sceneGeometry.visibleImageRect` pins the crop to
 * the BOTTOM of the painting, because the cave floor the dwarfs stand on is
 * painted in the lowest band and must never be what gets cropped. The map is
 * `object-position: 50% 50%` — the design says a centred image — so its crop is
 * symmetric on both axes. Generalising one function over both would put the
 * map's anchor inside the cave's module, and the whole point of the coordinate
 * rule is that a reader is never in doubt which space they are standing in.
 * `components/` and `lib/` already carry `map`, `scene` and `vault` as parallel
 * families for the same reason (see src/README.md).
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

/** The sub-rectangle of the painting that survives the crop, in image percent. */
export interface MapImageRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

const WHOLE_PAINTING: MapImageRect = { x0: 0, y0: 0, x1: 100, y1: 100 }

function unmeasured(box: MapBoxSize, image: MapBoxSize): boolean {
  return box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0
}

/**
 * Which part of the painting a box actually shows under
 * `object-fit: cover; object-position: 50% 50%`.
 *
 * `cover` scales the art until it covers the box, so exactly one axis overflows.
 * A box wider than the painting's ratio keeps the full width and loses equal
 * bands of sky and foreground; a narrower box keeps the full height and loses
 * equal margins on the left and right. Both are symmetric, which is the whole
 * difference from the cave.
 *
 * An unmeasured box — the first render, before a ResizeObserver has reported —
 * reports the whole painting, which makes projection the identity and leaves the
 * authored coordinates in charge until a real measurement arrives.
 */
export function visibleMapRect(box: MapBoxSize, image: MapBoxSize): MapImageRect {
  if (unmeasured(box, image)) return { ...WHOLE_PAINTING }
  const imageAspect = image.width / image.height
  const boxAspect = box.width / box.height
  if (boxAspect >= imageAspect) {
    // Scaled to the box's width: the surviving slice of height is centred.
    const halfHeight = 50 * (imageAspect / boxAspect)
    return { x0: 0, y0: 50 - halfHeight, x1: 100, y1: 50 + halfHeight }
  }
  // Scaled to the box's height: the surviving slice of width is centred.
  const halfWidth = 50 * (boxAspect / imageAspect)
  return { x0: 50 - halfWidth, y0: 0, x1: 50 + halfWidth, y1: 100 }
}

/**
 * How much bigger than life the painting is drawn in this box — whichever axis
 * `cover` had to magnify more. Zero for an unmeasured box, so a caller can test
 * it as falsy rather than guarding against Infinity.
 */
export function coverScaleOf(box: MapBoxSize, image: MapBoxSize): number {
  if (unmeasured(box, image)) return 0
  return Math.max(box.width / image.width, box.height / image.height)
}

/**
 * Project a point authored in image percent into the box's own percent space.
 *
 * Deliberately un-clamped, exactly as the cave's projection is: a point the crop
 * removed comes back outside 0-100, so a caller can tell "off the visible
 * painting" from "at the edge of it". `clampToMapBox` is the separate decision.
 */
export function projectToMapBox(point: MapPoint, box: MapBoxSize, image: MapBoxSize): MapPoint {
  // Returned untouched rather than run through the whole-painting rect, which
  // is the same answer but not the same number: dividing by 100 and multiplying
  // by 100 moves 31.92 to 31.920000000000005, and the first render is exactly
  // when a marker's position is compared against the authored value.
  if (unmeasured(box, image)) return { x: point.x, y: point.y }
  const rect = visibleMapRect(box, image)
  const width = rect.x1 - rect.x0
  const height = rect.y1 - rect.y0
  if (width <= 0 || height <= 0) return { x: point.x, y: point.y }
  return {
    x: ((point.x - rect.x0) / width) * 100,
    y: ((point.y - rect.y0) / height) * 100
  }
}

/**
 * Hold a projected point inside the box, leaving a margin for the marker's own
 * width and height.
 *
 * The design's own map container is exactly the painting's ratio, so nothing is
 * ever cropped there and it says nothing about this case. Ours is resizable, so
 * this is a decision: a mine whose spawn point the crop removed is drawn at the
 * edge of the panel rather than vanishing off it — the same answer the cave
 * already gives a dwarf whose rock got cropped away. A marker held at the edge
 * is in the wrong place and readable; a marker off the edge is a live project
 * the user cannot see.
 */
export function clampToMapBox(point: MapPoint, marginX: number, marginY: number): MapPoint {
  return {
    x: Math.min(Math.max(point.x, marginX), 100 - marginX),
    y: Math.min(Math.max(point.y, marginY), 100 - marginY)
  }
}
