/**
 * How tall the message panel opens, and how tall a drag may make it (#159).
 *
 * `screens/mine.md` states four rules and this file is three of them:
 *
 * - the initial height DERIVES from the selected dwarf's latest message;
 * - once open, new messages do not resize it;
 * - closing and reopening RECALCULATES from the latest message;
 * - the user may resize it vertically only.
 *
 * Rules two and three are why this is a pure function with no memory in it:
 * the panel calls it when it opens and never again, so a taller reply cannot
 * push the panel around mid-read, and a reopen is simply another call.
 *
 * What the design does NOT give is the mapping from a message to a height —
 * that is Unspecified, so the constants below are ours and are named rather
 * than scattered. They were measured off the design's own base export
 * (`assets/messages/message-panel.png`, 233px tall around a six-line reply in
 * an ~865px bubble), which is what makes a six-line message here land within a
 * few pixels of the mock.
 */

/** Everything that is not bubble: the title bar, the input row, the padding between them. */
export const MESSAGE_PANEL_CHROME_HEIGHT = 128

/** A one-line message still gets a panel worth opening. */
export const MESSAGE_PANEL_MIN_HEIGHT = 150

/**
 * The ceiling. The panel is docked over a live mine and the design is explicit
 * that the mine stays visible, so an agent that wrote an essay gets a scrolling
 * bubble rather than a panel that eats the screen — the messages scroll
 * independently for exactly this reason.
 */
export const MESSAGE_PANEL_MAX_HEIGHT = 420

/** 10px pixel type at the panel's own line height. */
const BUBBLE_LINE_HEIGHT = 14
/** Roughly what fits on one line of the design's ~865px-wide bubble at 10px. */
const BUBBLE_CHARS_PER_LINE = 130
/** The bubble's own vertical padding, top and bottom together. */
const BUBBLE_PADDING = 16

/**
 * How many lines a message takes once wrapped — its own line breaks included,
 * because a reply of six short lines is six lines tall however few characters
 * it spends.
 */
function lineCount(text: string): number {
  return text
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / BUBBLE_CHARS_PER_LINE)), 0)
}

/** Hold a height inside the panel's range, at a whole pixel. */
export function clampPanelHeight(height: number): number {
  return Math.min(MESSAGE_PANEL_MAX_HEIGHT, Math.max(MESSAGE_PANEL_MIN_HEIGHT, Math.round(height)))
}

/** The height the panel opens at for this latest message. Pure — see the module comment. */
export function initialPanelHeight(latest: string | undefined): number {
  if (latest === undefined || latest.trim() === '') return MESSAGE_PANEL_MIN_HEIGHT
  return clampPanelHeight(
    MESSAGE_PANEL_CHROME_HEIGHT + BUBBLE_PADDING + lineCount(latest) * BUBBLE_LINE_HEIGHT
  )
}
