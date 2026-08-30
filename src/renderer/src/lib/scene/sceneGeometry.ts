/**
 * Mapping authored points on a cave painting onto the box that renders it.
 *
 * ## Why this exists at all
 *
 * `mapSites.ts` gets away with authoring coordinates directly in *box* percent
 * because the valley painting is drawn with `object-position: 50% 60%`: the
 * crop contracts inward from every edge, so an authored point can only ever
 * drift toward the middle of the valley and a conservative central band is
 * enough to keep it honest.
 *
 * The cave interiors do not get that gift. They are tall portrait art (1289 x
 * 1600) rendered into a much squarer, resizable panel with
 * `object-fit: cover; object-position: 50% 100%` — pinned to the *bottom*,
 * because the floor the dwarfs stand on is painted in the lowest band and must
 * never be the part that gets cropped. The consequence is that the visible
 * window is always the bottom of the painting, and how much of it survives
 * swings enormously with the panel's shape: a 460-wide panel shows nearly the
 * whole painting, a panel dragged twice as wide shows only its lowest third.
 * A point authored at box y 50% would sit on the tunnel mouth in one shape and
 * on the foreground boulders in another.
 *
 * So anchors are authored in *image* percent — glued to the rock they name —
 * and projected into box percent here, from the box's measured size. A dwarf
 * at the ore shelf stays at the ore shelf at every panel shape, which is the
 * whole difference between inhabiting the cave and standing in front of it.
 */
import type { ScenePoint } from './sceneLayout'

/** A rendered box, in CSS pixels. Only its ratio matters to the maths below. */
export interface BoxSize {
  width: number
  height: number
}

/** The sub-rectangle of a painting that survives the crop, in image percent. */
export interface ImageRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

const WHOLE_PAINTING: ImageRect = { x0: 0, y0: 0, x1: 100, y1: 100 }

/**
 * Which part of the painting a box actually shows under
 * `object-fit: cover; object-position: 50% 100%`.
 *
 * `cover` scales the art until it covers the box, so exactly one axis overflows
 * and gets cropped. A box wider than the art crops the ceiling and keeps the
 * floor (the bottom pin); a box narrower than the art crops the two side walls
 * symmetrically (the 50% horizontal pin).
 *
 * An unmeasured box — the first render, before a ResizeObserver has reported —
 * reports the whole painting, which makes projection the identity and leaves
 * the authored coordinates in charge until a real measurement arrives.
 */
export function visibleImageRect(box: BoxSize, image: BoxSize): ImageRect {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) {
    return { ...WHOLE_PAINTING }
  }
  const imageAspect = image.width / image.height
  const boxAspect = box.width / box.height
  if (boxAspect >= imageAspect) {
    // Scaled to the box's width: the surviving slice of height sits at the bottom.
    const visibleHeight = 100 * (imageAspect / boxAspect)
    return { x0: 0, y0: 100 - visibleHeight, x1: 100, y1: 100 }
  }
  // Scaled to the box's height: the surviving slice of width sits in the middle.
  const halfWidth = 50 * (boxAspect / imageAspect)
  return { x0: 50 - halfWidth, y0: 0, x1: 50 + halfWidth, y1: 100 }
}

/**
 * How much bigger than life the painting is drawn in this box.
 *
 * The other half of the same `cover` sum `visibleImageRect` does: that one asks
 * which slice of the art survives, this one asks what that slice is magnified
 * by. `cover` scales until the art covers BOTH axes, so the scale is whichever
 * axis needs more — and everything painted in the surviving slice, the rock and
 * the timber and the ore, is drawn at exactly this factor.
 *
 * Which is why a dwarf's own drawn size has to come from here (see
 * sceneSizing.ts): he is a figure IN the painting, and a figure that does not
 * scale with the rock he leans on stops being in the cave and starts being
 * pasted over it.
 *
 * An unmeasured box reports 0 rather than Infinity or NaN, so a caller can test
 * it as falsy and fall back the way `visibleImageRect` does.
 */
export function coverScale(box: BoxSize, image: BoxSize): number {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) return 0
  return Math.max(box.width / image.width, box.height / image.height)
}

/**
 * Project an authored image-percent point into the box's own percent space.
 *
 * Deliberately un-clamped: a point the crop removed comes back outside 0-100
 * so a caller can tell "off the visible painting" from "at the edge of it".
 * Use `clampToBox` when something has to stay on screen regardless.
 */
export function projectToBox(point: ScenePoint, box: BoxSize, image: BoxSize): ScenePoint {
  const rect = visibleImageRect(box, image)
  const width = rect.x1 - rect.x0
  const height = rect.y1 - rect.y0
  if (width <= 0 || height <= 0) return { x: point.x, y: point.y }
  return {
    x: ((point.x - rect.x0) / width) * 100,
    y: ((point.y - rect.y0) / height) * 100
  }
}

/**
 * Hold a projected point inside the box, leaving a margin for the sprite's own
 * width and height. A dwarf whose painted feature got cropped away stands at
 * the edge of the panel instead of vanishing off it.
 */
export function clampToBox(point: ScenePoint, marginX: number, marginY: number): ScenePoint {
  return {
    x: Math.min(Math.max(point.x, marginX), 100 - marginX),
    y: Math.min(Math.max(point.y, marginY), 100 - marginY)
  }
}
