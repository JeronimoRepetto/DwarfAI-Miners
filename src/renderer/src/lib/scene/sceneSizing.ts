/**
 * How big a dwarf is drawn, and the smallest panel the cave still reads in.
 *
 * ## Why a sprite cannot be a constant (issue #44)
 *
 * A dwarf used to be `height: 100px`, modulated only by perspective depth. The
 * panel's own size never entered into it, so dragging the panel small held the
 * same sprites in less room instead of the same scene in a smaller frame: seven
 * 100px dwarfs in a 200px-wide cave are one unreadable clump.
 *
 * The fix is to stop treating him as a widget sitting on the painting and start
 * treating him as a figure inside it. `object-fit: cover` magnifies everything
 * in the surviving slice of art by `coverScale` (see sceneGeometry), so the
 * boulder he leans on, the timber post and the ore shelf all grow and shrink by
 * that factor as the panel is resized. A dwarf drawn at any other factor is
 * pasted over the cave rather than standing in it. So:
 *
 *     drawn height = authored height x (this box's cover scale / the authored box's)
 *
 * Calibrated against the pair the art was actually authored at — a 100px sprite
 * in the 428x512 cave the default 460x600 panel produces — so the default panel
 * renders byte-for-byte what it rendered before, and every other shape follows
 * the painting. `--depth-scale` still multiplies on top: that is perspective
 * within the scene, this is the scene's own scale.
 *
 * ## Why that implies a minimum panel size, rather than the other way round
 *
 * Because the crew now scales with the painting, the scene is very nearly
 * scale-free: the same crop, the same anchors, the same relative footprints at
 * every size. What is NOT scale-free is the crop's horizontal reach. A box
 * narrower than the art has its side walls eaten by `cover`, and the anchors are
 * glued to painted features, so past some narrowness the outermost anchor is
 * cropped away entirely and the dwarf standing on it gets held at the panel edge
 * (`clampToBox`) instead of standing on the rock he is named for.
 *
 * That is the floor, and it is computed rather than chosen: the cave's own
 * declared `min-height` for the vertical, and for the horizontal the narrowest
 * width at which every authored anchor still lands inside the visible crop with
 * a whole sprite footprint of clearance. Add the chrome around the cave and it
 * is a `minWidth`/`minHeight` for the BrowserWindow.
 *
 * The other end of the range needs no minimum: a box much WIDER than the art
 * crops the ceiling instead, and an anchor lost off the top is already held on
 * screen by `clampToBox`. A window minimum could not express an aspect bound
 * anyway.
 *
 * Everything here is pure arithmetic on measured boxes, so the floor is unit
 * tested — including from the main process, which is why this module imports no
 * art assets and touches no DOM (see the note on CAVE_ART_SIZE).
 */
import { coverScale, projectToBox, type BoxSize } from './sceneGeometry'
import { CAVE_LAYOUT, type SceneLayout } from './sceneLayout'
import { SPRITE_FRAME_SIZE } from '../sprite/spriteSheet'

/**
 * The interior paintings' pixel size, a deliberate copy of art.ts's
 * `INTERIOR_ART_SIZE`.
 *
 * The copy exists so `src/main/window.test.ts` can re-derive the window minimum
 * from this module: art.ts imports the bundled `.jpg`/`.png` assets, and the
 * main-process TypeScript project has no `vite/client` types to resolve them
 * with. `sceneSizing.test.ts` — which lives on the renderer side and CAN import
 * art.ts — holds the two equal, so the copy cannot drift unnoticed.
 */
export const CAVE_ART_SIZE: BoxSize = { width: 1289, height: 1600 }

/** The panel's authored size: what `buildMainWindowOptions` opens the window at. */
export const AUTHORED_PANEL_SIZE: BoxSize = { width: 460, height: 600 }

/**
 * The cave box that authored panel produces, measured once off the running app.
 * Doubles as the fallback MineScene draws with before its ResizeObserver has
 * reported — and in tests, where jsdom lays nothing out and every rect is 0x0.
 */
export const AUTHORED_CAVE_BOX: BoxSize = { width: 428, height: 512 }

/**
 * The chrome around the cave: the scene's own padding and the header row above
 * it. Derived from the two authored pairs rather than measured separately, so
 * there is nothing here to keep in sync — change either pair and this follows.
 */
export const PANEL_CHROME: BoxSize = {
  width: AUTHORED_PANEL_SIZE.width - AUTHORED_CAVE_BOX.width,
  height: AUTHORED_PANEL_SIZE.height - AUTHORED_CAVE_BOX.height
}

/**
 * How tall a dwarf is drawn in the cave the art was calibrated in.
 *
 * This is the SCENE's number, not the art's: it is how big a figure standing
 * next to that boulder has to be, and it does not move when the drawing behind
 * it is redone at another pixel size. It has been 100 since issue #44.
 */
const AUTHORED_SPRITE_HEIGHT = 100

/**
 * The sprite as drawn: the calibrated height above, at the shape of the frame
 * the dwarfs are actually painted in (issue #87).
 *
 * The width follows the art rather than being chosen, because everything that
 * reads this box reads it to ask for CLEARANCE — half a width before a dwarf is
 * clamped to the panel edge, a whole footprint before an anchor counts as
 * fitting — and a figure measured wider or narrower than it is drawn is a dwarf
 * held off his rock or allowed to hang over the frame.
 *
 * It replaces a hard-coded 96x100, which was the box `.dwarf-sprite` reserved
 * for the AI-painted poses. The pixel frames are slightly narrower, so every
 * clearance check has a little more room than it was tuned with and no anchor
 * that fitted can stop fitting — see sceneSizing.test.ts, which says so.
 */
export const AUTHORED_SPRITE: BoxSize = {
  width: (AUTHORED_SPRITE_HEIGHT * SPRITE_FRAME_SIZE.width) / SPRITE_FRAME_SIZE.height,
  height: AUTHORED_SPRITE_HEIGHT
}

/**
 * The cave's own declared vertical floor, bound into `.cave { min-height }` by
 * MineScene so the CSS and this derivation cannot disagree.
 *
 * It predates issue #44 and was always honest about what the scene needs; what
 * it never had was any way to enforce itself, because the WINDOW had no minimum
 * and a cave floored at 320px inside a 200px panel simply overflows.
 */
export const CAVE_MIN_HEIGHT_PX = 320

/**
 * A readability floor for width, the horizontal twin of the height above.
 *
 * Geometry alone stopped binding here once the ore deposit was excluded from
 * the fit check: with only the anchors dwarfs stand on to satisfy, the crop
 * lets the box get considerably narrower than anyone would want to look at.
 * The scene would still be geometrically correct at that width — every dwarf
 * on his own rock, just very small — which is exactly why geometry is the
 * wrong thing to ask.
 *
 * Set to the width the derivation produced while the deposit still bound it,
 * so the window floor did not quietly loosen when the ore heap moved into the
 * corner. Moving a pile is not a reason to let the panel shrink.
 */
export const CAVE_MIN_WIDTH_PX = 244

/**
 * Vertical clearance for a dwarf's feet, in box percent.
 *
 * Not half his height: he is positioned by his FEET, so what has to stay clear
 * is the name label hanging below them and a little air above. Left as a flat
 * percentage on purpose — the label is 10px type that does not scale with the
 * panel, so nothing about it belongs to the painting's cover scale.
 */
export const SPRITE_FEET_MARGIN_PERCENT = 4

/**
 * How tall a dwarf is drawn in this cave box, before perspective depth.
 *
 * An unmeasured box or an unmeasured painting hands back the authored height,
 * the same convention `visibleImageRect` uses: "no measurement yet" is never
 * "a cave of no size".
 */
export function spriteHeightPx(box: BoxSize, art: BoxSize): number {
  const cover = coverScale(box, art)
  const authored = coverScale(AUTHORED_CAVE_BOX, art)
  if (cover <= 0 || authored <= 0) return AUTHORED_SPRITE.height
  return AUTHORED_SPRITE.height * (cover / authored)
}

/**
 * The whole drawn box of a dwarf in this cave box. The width follows the height
 * because every pose shares one canvas, so fixing one fixes the other.
 */
export function spriteFootprintPx(box: BoxSize, art: BoxSize): BoxSize {
  const height = spriteHeightPx(box, art)
  return { width: height * (AUTHORED_SPRITE.width / AUTHORED_SPRITE.height), height }
}

/**
 * The margins `clampToBox` needs to keep a dwarf on screen, in box percent.
 *
 * The horizontal one is half his drawn width and therefore moves with the panel
 * — that is the whole point of the sizing above, and hard-coding it was what
 * made a narrow panel clamp dwarfs it should have left alone.
 */
export function spriteMarginPercent(box: BoxSize, art: BoxSize): { x: number; y: number } {
  const measured = box.width > 0 && box.height > 0 ? box : AUTHORED_CAVE_BOX
  const footprint = spriteFootprintPx(measured, art)
  return { x: (50 * footprint.width) / measured.width, y: SPRITE_FEET_MARGIN_PERCENT }
}

/**
 * Whether every anchor a DWARF uses still stands where the painting says it
 * does in this cave box — inside the crop, and far enough from the edge that
 * the sprite on it is drawn whole rather than held against the frame.
 *
 * Checked with the sprite footprint, which is the largest thing that ever
 * stands on one of these anchors at or above the minimum size.
 *
 * Deposits are excluded, and that exclusion is what lets them sit in the very
 * corner. A dwarf held against the frame by the crop is standing on nothing,
 * which is the failure this minimum exists to prevent; a heap of ore held
 * against the frame is exactly where a corner heap belongs. Including them
 * would let the ore pile — which is allowed to be clipped — dictate how small
 * the window may be, which is backwards.
 */
export function anchorsFitCaveBox(box: BoxSize, art: BoxSize, layout: SceneLayout): boolean {
  const margin = spriteMarginPercent(box, art)
  const occupied = layout.anchors.filter((anchor) => anchor.kind !== 'deposit')
  return occupied.every((anchor) => {
    const point = projectToBox(anchor, box, art)
    return (
      point.x >= margin.x &&
      point.x <= 100 - margin.x &&
      point.y >= margin.y &&
      point.y <= 100 - margin.y
    )
  })
}

/**
 * The narrowest cave box in which the authored scene still reads.
 *
 * Searched rather than solved: the closed form depends on which axis the crop
 * is currently bound by, and a search says what it is looking for out loud and
 * keeps saying it if the anchors are ever re-authored. The condition is
 * monotone in width — a wider box shows more of the painting AND spends a
 * smaller share of itself on each sprite — so the first width that fits is the
 * smallest one.
 *
 * The cap is the width at which the box stops being narrower than the art: past
 * that nothing more of the side walls can be recovered, so a layout that still
 * does not fit is an authoring bug, not a size problem.
 */
export function smallestReadableCaveWidth(
  height: number,
  art: BoxSize,
  layout: SceneLayout
): number {
  const cap = Math.ceil((height * art.width) / art.height)
  for (let width = 1; width <= cap; width++) {
    if (anchorsFitCaveBox({ width, height }, art, layout)) return width
  }
  return cap
}

/**
 * The smallest cave the authored interior still reads in: whichever of the two
 * floors binds harder. Geometry says where the crop starts stealing anchors;
 * CAVE_MIN_WIDTH_PX says where the picture stops being worth looking at. Both
 * are real limits and the scene needs to clear both.
 */
export const SMALLEST_READABLE_CAVE_BOX: BoxSize = {
  width: Math.max(
    CAVE_MIN_WIDTH_PX,
    smallestReadableCaveWidth(CAVE_MIN_HEIGHT_PX, CAVE_ART_SIZE, CAVE_LAYOUT)
  ),
  height: CAVE_MIN_HEIGHT_PX
}

/**
 * The BrowserWindow floor: that cave, plus the chrome that surrounds it.
 * `buildMainWindowOptions` carries these as `minWidth`/`minHeight`, which is
 * what makes the floor unreachable rather than merely recommended.
 */
export const MIN_PANEL_SIZE: BoxSize = {
  width: SMALLEST_READABLE_CAVE_BOX.width + PANEL_CHROME.width,
  height: SMALLEST_READABLE_CAVE_BOX.height + PANEL_CHROME.height
}
