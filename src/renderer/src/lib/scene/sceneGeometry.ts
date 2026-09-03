/**
 * Mapping authored points on the interior painting onto the box that renders it.
 *
 * ## Why this exists at all
 *
 * `mapSites.ts` gets away with authoring coordinates directly in *box* percent
 * because the valley painting is drawn with `object-position: 50% 60%`: the
 * crop contracts inward from every edge, so an authored point can only ever
 * drift toward the middle of the valley and a conservative central band is
 * enough to keep it honest.
 *
 * The interiors do not get that gift. They are a 1184 x 3622 tower — three
 * times taller than they are wide — drawn into a 245px column whose height is
 * the whole screen. The design frames that column at the painting's own shape,
 * but a docked panel on a real display is far taller than that, so how the
 * leftover height is spent is the whole question. It is spent on empty column
 * rather than on crop: `contain`, centred. Every work point in this painting is
 * load-bearing, from the ceiling gallery to the entrance pool, and `cover` at a
 * full-screen column height would eat 28% of the map's width and strand the
 * outermost of them.
 *
 * Both fits are implemented anyway, because they are the same sum with one
 * `min` swapped for a `max`, and having them side by side is what makes the
 * projection testable in both directions rather than only in the one the app
 * happens to use.
 *
 * So anchors are authored in *image* percent — glued to the rock they name —
 * and projected into box percent here, from the box's measured size. A dwarf at
 * the ore vein stays at the ore vein at every column shape, which is the whole
 * difference between inhabiting the mine and standing in front of it.
 */
import type { ScenePoint } from './sceneLayout'

/** A rendered box, in CSS pixels. Only its ratio matters to the maths below. */
export interface BoxSize {
  width: number
  height: number
}

/** How the painting is sized into its box — the CSS `object-fit` of the same name. */
export type ImageFit = 'cover' | 'contain'

/**
 * Where the painting is drawn, in the BOX's own percent space.
 *
 * Under `contain` this is inside the box on at least one axis (the letterbox);
 * under `cover` it is outside it on at least one axis (the crop). Deliberately
 * one type for both, because everything downstream only ever wants "the
 * rectangle the painting occupies".
 */
export interface DrawnRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

const WHOLE_BOX: DrawnRect = { x0: 0, y0: 0, x1: 100, y1: 100 }

/**
 * How much bigger or smaller than life the painting is drawn in this box.
 *
 * `contain` scales until the art fits BOTH axes, so the scale is whichever axis
 * needs less; `cover` scales until it covers both, so it is whichever needs
 * more. Everything painted — the rock, the timber, the ore — is drawn at
 * exactly this factor.
 *
 * Which is why a dwarf's own drawn size has to come from here (see
 * sceneSizing.ts): he is a figure IN the painting, and a figure that does not
 * scale with the rock he leans on stops being in the mine and starts being
 * pasted over it.
 *
 * An unmeasured box reports 0 rather than Infinity or NaN, so a caller can test
 * it as falsy and fall back the way `drawnImageRect` does.
 */
export function fitScale(box: BoxSize, image: BoxSize, fit: ImageFit): number {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) return 0
  const byWidth = box.width / image.width
  const byHeight = box.height / image.height
  return fit === 'cover' ? Math.max(byWidth, byHeight) : Math.min(byWidth, byHeight)
}

/**
 * The rectangle the painting occupies in this box, centred on both axes —
 * `object-position: 50% 50%`, which is what makes the letterbox symmetric.
 *
 * An unmeasured box — the first render, before a ResizeObserver has reported —
 * reports the whole box, which makes projection the identity and leaves the
 * authored coordinates in charge until a real measurement arrives.
 */
export function drawnImageRect(box: BoxSize, image: BoxSize, fit: ImageFit): DrawnRect {
  const scale = fitScale(box, image, fit)
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
 * Project an authored image-percent point into the box's own percent space.
 *
 * Deliberately un-clamped: a point a `cover` crop removed comes back outside
 * 0-100 so a caller can tell "off the visible painting" from "at the edge of
 * it". Use `clampToBox` when something has to stay on screen regardless.
 */
export function projectToBox(
  point: ScenePoint,
  box: BoxSize,
  image: BoxSize,
  fit: ImageFit
): ScenePoint {
  const rect = drawnImageRect(box, image, fit)
  return {
    x: rect.x0 + (point.x / 100) * (rect.x1 - rect.x0),
    y: rect.y0 + (point.y / 100) * (rect.y1 - rect.y0)
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
