/**
 * Which presses on the message-panel window may move it (#296).
 *
 * The panel is a frameless window, so there is no title bar to grab: a drag
 * region has to be declared, and the design's own header row — the name, the
 * history arrow, the close glyph — is the row the issue names. Both surfaces
 * that share this window draw that row (`DwarfMessagePanel` and `AddPanel`,
 * both as `header.panel-bar`), and each marks it with the attribute below;
 * matching the marker rather than the class keeps this from being a second
 * opinion about the stylesheet.
 *
 * Pure and DOM-only on purpose. The gesture itself belongs to the window's own
 * root component and the geometry belongs to MAIN — the one decision that can
 * be asserted without either is whether a press landed on something draggable,
 * and this is it.
 */

/** The marker either panel's header row carries. */
export const WINDOW_DRAG_ATTRIBUTE = 'data-window-drag'

/**
 * The things inside that row which are NOT a handle.
 *
 * The header is mostly inert — a name and a glyph — but the name focuses the
 * session's console and the glyph closes the panel, and a drag that swallowed
 * either would take a control away from the person to move a window they did
 * not ask to move. Selected by role rather than by class so a control added to
 * the row later is excluded by default, which is the safer direction: a
 * missing handle is visible, a control that stopped working is not.
 */
const CONTROL_SELECTOR = 'button, a, input, textarea, select, [role="separator"], [role="button"]'

/**
 * Whether a press on this element may drag the whole window.
 *
 * Inside a marked header, and not on one of its controls. Anything that is not
 * an element — a press with no target at all, a text node — is refused rather
 * than guessed at: nothing that cannot be located in the header can be proven
 * to be part of it.
 */
export function isWindowDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest(`[${WINDOW_DRAG_ATTRIBUTE}]`) === null) return false
  return target.closest(CONTROL_SELECTOR) === null
}
