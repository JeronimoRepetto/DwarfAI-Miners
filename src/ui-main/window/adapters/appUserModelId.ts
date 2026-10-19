import type { UiPlatform } from './ElectronScreenArea'

/**
 * The identity Windows attributes this app's notifications to (ADR-018 item 7; 16 §4.14 row `NotificationDisplay`:
 * "AUMID from `appUserModelId.ts`"). Transplanted from `src/main/notifications/appUserModelId.ts` (#316), kept as it
 * was: the legacy tree may not be imported from here (R16), and the legacy file stays until cut 5.
 *
 * What #316 measured: on Windows 11 with Electron 44 a non-packaged build shows a toast with the identity set and
 * without it, so this is not what makes a toast appear. It is set for what it does do: Electron documents it as the
 * identity a toast is attributed to, and without it a dev build borrows Electron's own default rather than being this
 * app in the Action Center, the one place a person turns notifications off per app. A packaged build gets the same
 * identity from the shortcut the installer writes, derived from `build.appId`; appUserModelId.test.ts keeps the two
 * equal.
 */
export const APP_USER_MODEL_ID = 'com.jeronimorepetto.dwarfaiminers'

/**
 * Whether this platform needs the identity set from inside the process. A parameter rather than a read of the running
 * OS, so the macOS and Linux answers are assertable on a Windows host (`platform-ports`): macOS keys notifications off
 * the bundle and Linux off the D-Bus name.
 */
export function needsAppUserModelId(platform: UiPlatform): boolean {
  return platform === 'win32'
}
