// The S-018-1 spike gate of level-3 notifications drawn by the windowless tray process (spike register S-018-1;
// 21 §9 "Cut 1 entry"; 21 §2 cut 1 entry criteria; ADR-018 item 5 and Open items; 24-issues README §6 "Spike gates").
// Pure data.
//
// While S-018-1 has not passed on an OS, the documented fallback holds there: level-3 notifications are drawn only
// while a window is open, and one arriving with none is not drawn (notificationPresenter.ts; 13 FM-048); release note
// R-16 lists the limitation (20 §8; 21 §9). The Host side is unchanged: it sends to the `notifier` connection on every
// OS (ISSUE-112). Once `spike-results/S-018-1.md` records a pass on an OS, its entry here turns `true` in the same
// change; trayNotificationGate.test.ts refuses a `true` without a passed line for that OS.
export type TrayNotificationPlatform = 'win32' | 'darwin' | 'linux'

export const TRAY_NOTIFICATIONS_PASSED: Readonly<Record<TrayNotificationPlatform, boolean>> = {
  win32: false,
  darwin: false,
  linux: false
}

/** Whether the tray process draws level-3 notifications with no window open on `platform` (S-018-1 passed there). */
export function drawsWithoutWindow(platform: TrayNotificationPlatform): boolean {
  return TRAY_NOTIFICATIONS_PASSED[platform]
}
