// A-N12 `onUiPreferencesReset` (14 §2.2: NEW, `ui-local`, owner `window`; §3.8 `{ epoch: number }`; ADR-024 item 8;
// ADR-023 item 4 step 5): UI main tells every window, shown or hidden, that it reset its stores for a Reset metrics
// epoch (window/application/uiPreferencesReset.ts); each window then re-reads A-N17 `getUiSession` and A-N20
// `getUiPreferences` and replaces its copies (14 §3.9, AMENDMENT-1). The payload is only the epoch: nothing of the
// reset rides on it.
//
// A push is sent, never served: no route target answers it. The row is born `ui-local` in cut 1 and listed in
// `unrouted.ts` until the cut-1 switch (ISSUE-123) routes it; until then the composition hands this push no window.
import type { ChannelKey } from '@dwarfai/contracts'
import type { ModeWindowSender } from '../../window/application/uiPreferences'

/** A-N12 (push). */
export const UI_PREFERENCES_RESET_PUSH = 'ui:preferences:reset' satisfies ChannelKey

/** Sends A-N12 `{ epoch }` to each window `windows()` answers at the time of the push. */
export function createUiPreferencesResetPush(
  windows: () => readonly ModeWindowSender[]
): (reset: { epoch: number }) => void {
  return ({ epoch }) => {
    for (const window of windows()) window.send(UI_PREFERENCES_RESET_PUSH, { epoch })
  }
}
