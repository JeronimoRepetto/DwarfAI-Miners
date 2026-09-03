import type { DwarfActivation } from '../../types'

/**
 * Whether the floating panel should hide itself after a dwarf activation.
 *
 * The panel is `alwaysOnTop` (see main/shell/window.ts), so it never needs to
 * get out of the way of a focused window or a newly opened terminal — both just
 * appear underneath/alongside it. The panel only hides when the user asks it to,
 * never as a side effect of clicking a dwarf. Kept as its own guard (rather than
 * inlined at the call site) so a future product decision to hide in some case
 * has one tested place to change.
 *
 * Since #90 the docked shell's usual way out of the user's way is collapsing to
 * the rail; hiding the window entirely is the tray, the global shortcut, and the
 * settings panel's Hide button — which is the renderer's only caller left, this
 * guard having always answered false.
 */
export function shouldHidePanelAfterActivation(_result: DwarfActivation): boolean {
  return false
}
