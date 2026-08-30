import type { DwarfActivation } from '../../types'

/**
 * Whether the floating panel should hide itself after a dwarf activation.
 *
 * The panel is `alwaysOnTop` (see main/window.ts), so it never needs to get
 * out of the way of a focused window or a newly opened terminal — both just
 * appear underneath/alongside it. The panel only hides when the user
 * explicitly closes it (the titlebar button), never as a side effect of
 * clicking a dwarf. Kept as its own guard (rather than inlined at the call
 * site) so a future product decision to hide in some case has one tested
 * place to change.
 */
export function shouldHidePanelAfterActivation(_result: DwarfActivation): boolean {
  return false
}
