/**
 * Vertical stagger for speech bubbles that share a scene anchor (issue #43).
 *
 * `SpeechBubble` draws itself directly above its own sprite and knows nothing
 * about any other bubble on screen — fine while at most a couple of dwarfs
 * ever stood near each other, but #19 made anchor-sharing routine: once
 * working dwarfs outnumber the painted veins, several of them stand on the
 * very same rock (see `sceneAssignment.ts`'s `ScenePlacement.shareIndex`),
 * spread only `SHARE_SPREAD_X` image-percent apart — a few dozen pixels —
 * while a bubble can be up to 150px wide. Every sharer's bubble then lands at
 * the same height and smears into its neighbours', which is exactly the
 * seven-dwarf screenshot this issue was filed from.
 *
 * The fix reuses the very index sceneAssignment already hands out to spread
 * the DWARFS themselves sideways: the one dwarf alone on an anchor is index 0
 * and stays at row 0 — precisely the spot the bubble has always occupied —
 * and each further sharer climbs one row higher, so a crowded rock reads as a
 * stack of distinct lines instead of one illegible smear.
 *
 * This is the cheapest of the three options the issue weighs (stagger vs. a
 * visible-bubble limit vs. full collision-aware placement like
 * `computeTooltipPlacement`): it costs one CSS custom property, drops no
 * message — every dwarf keeps its bubble — and needs no DOM measurement to
 * reason about or to test. It is sized for the common case (a truncated
 * one-to-two-line bubble); a rare full three-line bubble on a heavily shared
 * anchor may still brush the row above it, which full collision-aware
 * placement would be needed to rule out entirely.
 */

/** Vertical gap between two stacked bubble rows, in px. */
export const BUBBLE_ROW_HEIGHT_PX = 36

/**
 * How far to lift a bubble above its default spot so it clears every sharer
 * stacked below it. `shareIndex` is `ScenePlacement.shareIndex` — 0 for a
 * dwarf with an anchor to itself, which is why that case returns 0 and
 * changes nothing about where the bubble has always been drawn.
 */
export function bubbleRowOffsetPx(shareIndex: number): number {
  // A negative index is a caller bug, not a scene worth drawing wrong: floor
  // it at 0 so a malformed input can only leave the bubble in its default
  // spot, never push it BELOW its sprite.
  return Math.max(0, shareIndex) * BUBBLE_ROW_HEIGHT_PX
}
