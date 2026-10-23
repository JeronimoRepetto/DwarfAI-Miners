// The mode windows whose reports count for UI main's `PresenceTracker` (ADR-024 item 7; 14 A-44, B-M07; 07 S39.04,
// S39.05; US-SHELL-010.AC08; ISSUE-306): every mode window shown right now, each by its own mode. The Panel counts
// while it is shown and not minimized (`PanelWindowUseCases.visible`); the Veta and the Valle windows while the mode
// shell shows them (`ModeShell.shown`). A hidden window contributes no mine, and the tracker keeps its last report for
// its next show. Before ISSUE-306 every mode window counted only while the Panel was visible, so with Veta or Valle
// shown nothing was on screen and level 3 fired for mines in view.
//
// Pure: the composition root hands it the open mode windows, each window's mode and which modes are shown.

/** The mode a mode window serves. */
export type WindowMode = 'panel' | 'veta' | 'valle'

/** Whether each mode's window is shown (the Panel: shown and not minimized). */
export interface ShownModes {
  panel: boolean
  veta: boolean
  valle: boolean
}

/** The `webContents` ids of the windows in `windows` whose mode is shown, in the order given. */
export function shownModeWindows(
  windows: readonly number[],
  modeOf: (webContentsId: number) => WindowMode,
  shown: Readonly<ShownModes>
): number[] {
  return windows.filter((webContentsId) => shown[modeOf(webContentsId)])
}

/**
 * Whether any mode window is shown: the level-3 presenter's `anyWindowOpen` while S-018-1 has not passed, where a
 * notification is drawn only with a window open (trayNotificationGate.ts; 21 §9). Veta and Valle count as the Panel does.
 */
export function anyModeShown(shown: Readonly<ShownModes>): boolean {
  return shown.panel || shown.veta || shown.valle
}
