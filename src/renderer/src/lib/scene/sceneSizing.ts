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

/**
 * The design's interior column, from `--size-mine-interior-width`.
 *
 * Since #153 this is a REFERENCE rather than the column's width: it is the one
 * number the sprite scale is calibrated against (see DWARF_PAINTING_HEIGHT
 * below), and the value the derivation reproduces at the mock's own height. The
 * column the shell actually draws is `interiorColumnWidth` below.
 */
export const DESIGN_INTERIOR_WIDTH = 245

/**
 * How much of the window's height the shell spends before a painting sees any
 * of it: the 8px padding `App.vue` puts around the open shell, top and bottom.
 *
 * A deliberate copy of that stylesheet's `--space-nav-gap`, kept here because
 * main has to reserve the width this height derives and cannot read CSS. The
 * frame's own 2px border is NOT counted: the painting is drawn `contain` inside
 * it, so the four pixels it costs letterbox rather than crop, and counting them
 * would make the column disagree with the `aspect-ratio` the stylesheet sets.
 */
export const SHELL_CONTENT_INSET = 16

/**
 * How wide the mine column is on a window this tall (#153).
 *
 * The maintainer's acceptance ruling, evaluated: the painting is drawn at the
 * FULL HEIGHT of the shell's content area with its aspect preserved and nothing
 * cropped, so the width follows the height. The design's 245 is what this
 * returns at the mock's own 768-tall composition — it was never a constant, and
 * treating it as one is what made the interior read tiny on a 1392-tall display.
 *
 * Whole pixels, because main reserves the same number in the window and Electron
 * bounds take nothing else; `panelBounds.test.ts` holds the two derivations
 * equal at every height.
 */
export function interiorColumnWidth(windowHeightPx: number): number {
  const content = windowHeightPx - SHELL_CONTENT_INSET
  return Math.max(
    0,
    Math.round((content * INTERIOR_PAINTING_SIZE.width) / INTERIOR_PAINTING_SIZE.height)
  )
}

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
 * Close, History and Add's shared size (#197). `components.md` marks icon
 * sizes Unspecified, so there is no number to transcribe — this is measured
 * off the verified Canva export `assets/mine/mine-add-panel-open.png`, where
 * the interior column renders at very nearly 1:1 against the design's own
 * 245px (243px measured there, a rounding difference under half a percent).
 * At that scale Close's round "X" and Add's round "+" are both an 18px
 * circle; only the export's own black pressed-state backdrop around Add read
 * larger, which is a hover/press affordance and not the button's own size.
 * Close and History were already drawn at 18px as a stacked pair; Add now
 * joins them rather than the other way round, since 18px is what both
 * glyphs actually measure.
 */
export const MINE_ACTION_SIZE = 18

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
