/**
 * How big a dwarf is drawn in the mine interior.
 *
 * ## Why a sprite cannot be a constant (issue #44)
 *
 * A dwarf used to be `height: 100px` whatever the panel was doing, so a smaller
 * panel held the same sprites in less room instead of the same scene in a
 * smaller frame. The fix was to stop treating him as a widget sitting on the
 * painting and start treating him as a figure inside it: everything painted is
 * drawn at the painting's own fit scale, so he has to be too. A dwarf drawn at
 * any other factor is pasted over the mine rather than standing in it.
 *
 * ## What #137 changed: the number itself
 *
 * The calibration is now the design's rather than a measurement of the old
 * cave. `screens/mine.md` gives the interior as 245px wide and the worker and
 * foreman frames as 34x36 (the shipped sheets are 36x38), drawn at 1x — so a
 * dwarf is one sheet frame tall inside a 245px column, and everything else
 * follows from the painting's scale:
 *
 *     a dwarf is 38px tall in a 245px column
 *     the painting is 1184px wide, so 245px of column is 0.207x
 *     therefore he is 38 / 0.207 = 183.6 PAINTING pixels tall
 *     and in any box, drawn height = 183.6 x that box's fit scale
 *
 * At the design's own column that returns exactly 38px. The cave drew him at
 * 100px, which is 2.63x that — the "too big" the maintainer saw, and it was too
 * big by a factor nobody could have guessed at, because it was calibrated
 * against a different painting in a different frame.
 *
 * ## Why there is no window minimum here any more
 *
 * There used to be: the cave was drawn with `cover`, so a panel dragged narrow
 * cropped the side walls away and took the outermost anchors with them, and
 * this module searched for the narrowest box in which every anchor survived.
 * Two things ended that. The panel is docked and no longer resizable by hand
 * (#90), and the interior is drawn with `contain`, so nothing is ever cropped
 * at any shape — every workstation is on screen in a 40px column, just very
 * small. There is no geometric floor left to compute.
 */
import { fitScale, type BoxSize, type ImageFit } from './sceneGeometry'
import { INTERIOR_PAINTING_SIZE } from './interiorMap'
import { SPRITE_FRAME_SIZE } from '../sprite/spriteSheet'

/**
 * How the interior painting is sized into its column.
 *
 * `contain`, and the choice is load-bearing: this art is a 1184x3622 tower and
 * the docked column is the height of the display, so `cover` would scale to the
 * height and crop roughly a quarter of the painting's width away — taking the
 * outermost work points with it. Empty column above and below is the cheaper
 * failure than a map with its edges missing.
 */
export const INTERIOR_FIT: ImageFit = 'contain'

/** The design's interior column, from `--size-mine-interior-width`. */
export const DESIGN_INTERIOR_WIDTH = 245

/**
 * The interior box the design's own frame produces: 245px wide at the
 * painting's aspect ratio, which is the shape the mock draws it in.
 *
 * Doubles as the fallback MineScene draws with before its ResizeObserver has
 * reported — and in tests, where jsdom lays nothing out and every rect is 0x0.
 */
export const AUTHORED_INTERIOR_BOX: BoxSize = {
  width: DESIGN_INTERIOR_WIDTH,
  height: (DESIGN_INTERIOR_WIDTH * INTERIOR_PAINTING_SIZE.height) / INTERIOR_PAINTING_SIZE.width
}

/**
 * How tall a dwarf is, measured in pixels of the painting he stands in.
 *
 * The one calibrated number, and the header explains where it comes from: the
 * design draws a sheet frame at 1x in a 245px column, so his height in painting
 * pixels is the frame height scaled back up by how far the painting is scaled
 * down. Everything else in this module is arithmetic on it.
 */
export const DWARF_PAINTING_HEIGHT =
  (SPRITE_FRAME_SIZE.height * INTERIOR_PAINTING_SIZE.width) / DESIGN_INTERIOR_WIDTH

/**
 * Vertical clearance for a dwarf's feet, in box percent.
 *
 * Not half his height: he is positioned by his FEET, so what has to stay clear
 * is the name label hanging below them and a little air above. Left as a flat
 * percentage on purpose — the label is 10px type that does not scale with the
 * column, so nothing about it belongs to the painting's fit scale.
 */
export const SPRITE_FEET_MARGIN_PERCENT = 4

/**
 * How tall a dwarf is drawn in this interior box.
 *
 * An unmeasured box or an unmeasured painting hands back the height the design
 * calls for, the same convention `drawnImageRect` uses: "no measurement yet" is
 * never "a mine of no size".
 */
export function spriteHeightPx(box: BoxSize, art: BoxSize = INTERIOR_PAINTING_SIZE): number {
  const scale = fitScale(box, art, INTERIOR_FIT)
  if (scale <= 0) return SPRITE_FRAME_SIZE.height
  return DWARF_PAINTING_HEIGHT * scale
}

/**
 * The whole drawn box of a dwarf. The width follows the height because every
 * pose shares one sheet frame, so fixing one fixes the other.
 */
export function spriteFootprintPx(box: BoxSize, art: BoxSize = INTERIOR_PAINTING_SIZE): BoxSize {
  const height = spriteHeightPx(box, art)
  return { width: (height * SPRITE_FRAME_SIZE.width) / SPRITE_FRAME_SIZE.height, height }
}

/**
 * The margins `clampToBox` needs to keep a dwarf on screen, in box percent.
 *
 * The horizontal one is half his drawn width and therefore moves with the
 * column — that is the whole point of the sizing above, and hard-coding it was
 * what made a narrow panel clamp dwarfs it should have left alone.
 */
export function spriteMarginPercent(
  box: BoxSize,
  art: BoxSize = INTERIOR_PAINTING_SIZE
): { x: number; y: number } {
  const measured = box.width > 0 && box.height > 0 ? box : AUTHORED_INTERIOR_BOX
  const footprint = spriteFootprintPx(measured, art)
  return { x: (50 * footprint.width) / measured.width, y: SPRITE_FEET_MARGIN_PERCENT }
}
