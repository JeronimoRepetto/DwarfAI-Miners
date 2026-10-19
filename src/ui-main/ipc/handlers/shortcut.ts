import type { ShortcutState, ToggleShortcut } from '../../window/application/toggleShortcut'

/**
 * The `ui-local` handlers of A-10 `getToggleShortcut` / `shortcut:get` and A-11 `setToggleShortcut` / `shortcut:set`
 * (14 §2.1, KEEP; ADR-024 item 9), keyed by the wire name the router serves them under. The router's seam A gate
 * (`validateCall`, ISSUE-044) runs first, so the setter only ever receives a string: a payload that is not one is
 * answered with the unchanged state (A-10) before it gets here, and an accelerator the app refuses comes back as the
 * legacy failure shape, the state with its `error` (14 §1.5).
 *
 * The cut-0 switch (ISSUE-056) routes both rows here and turns off the legacy registration in the same change, so one
 * process never registers the global shortcut twice (21 §1 item 4).
 */
export interface ShortcutRows {
  'shortcut:get'(): ShortcutState
  'shortcut:set'(accelerator: string): ShortcutState
}

export function createShortcutRows(toggle: Pick<ToggleShortcut, 'state' | 'set'>): ShortcutRows {
  return {
    'shortcut:get': () => toggle.state(),
    'shortcut:set': (accelerator) => toggle.set(accelerator)
  }
}
