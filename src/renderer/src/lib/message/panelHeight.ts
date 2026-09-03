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
 * (`assets/messages/message-panel.png`: 235px tall, its portrait band exactly
 * 100px inside a 2px border, an ~865px bubble around a six-line reply), which
 * is what makes a six-line message here land within a few pixels of the mock.
 */

/** Everything that is not bubble: the title bar, the input row, the padding between them. */
export const MESSAGE_PANEL_CHROME_HEIGHT = 130

/**
 * The floor, and it is not arbitrary: the design's portrait is a fixed
 * `100px` square inside a `2px` border, so a panel shorter than the chrome
 * plus 104 could not draw one at the size the source states. Which is also why
 * the base export is 235px tall around a six-line reply — that message asks
 * for less room than its own portrait does.
 */
export const MESSAGE_PANEL_MIN_HEIGHT = MESSAGE_PANEL_CHROME_HEIGHT + 104

/**
 * The ceiling, measured off the design's own expanded-history export (578px).
 * It is what the history tab opens to, and the furthest a drag may go — the
 * panel is docked over a live mine and the source is explicit that the mine
 * stays visible, so an agent that wrote an essay gets a scrolling bubble
 * rather than a panel with no bottom to it.
 */
export const MESSAGE_PANEL_MAX_HEIGHT = 578

/**
 * The floor when the dwarf has an outstanding ask, measured off the design's
 * own question export (547px, against the base export's 235).
 *
 * An ask is not a line of text, it is a surface: the agent's options, its
 * `Other Thing` label and a box of its own, all of it REPLACING the composer.
 * A panel opened at the ordinary floor would have to squash the conversation
 * to nothing to fit one.
 */
export const MESSAGE_PANEL_ASK_HEIGHT = 547

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

/**
 * The height the panel opens at for this latest message, and for whether the
 * dwarf has an ask outstanding. Pure — see the module comment.
 *
 * `asking` raises the FLOOR rather than fixing the height: a long reply under
 * an open ask still asks for the room it needs, up to the ceiling.
 */
export function initialPanelHeight(latest: string | undefined, asking = false): number {
  const floor = asking ? MESSAGE_PANEL_ASK_HEIGHT : MESSAGE_PANEL_MIN_HEIGHT
  if (latest === undefined || latest.trim() === '') return clampPanelHeight(floor)
  const derived =
    MESSAGE_PANEL_CHROME_HEIGHT + BUBBLE_PADDING + lineCount(latest) * BUBBLE_LINE_HEIGHT
  return clampPanelHeight(Math.max(floor, derived))
}
