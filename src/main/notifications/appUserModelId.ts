import type { Platform } from '../platform/platform'

/**
 * The identity Windows attributes this app's notifications to (#316).
 *
 * ## What was measured, against what #316 assumed
 *
 * #316 states that Windows NEEDS this for a notification to show from a dev
 * build. That was checked here rather than restated, and it did not reproduce:
 * on Windows 11 with Electron 44, a non-packaged build reports
 * `Notification.isSupported()` true and its toast fires `show` with the
 * identity set and without it, repeatably. So this is not what makes a toast
 * appear, and nobody should later "fix" a missing notification by reaching for
 * it.
 *
 * It is still set, for the thing it does do: Electron documents it as the
 * identity a toast is attributed to, and without it a dev build borrows
 * Electron's own default rather than being this app in the Action Center — the
 * one place a person turns notifications off per app. A PACKAGED build gets
 * that identity from the shortcut the installer writes, derived from
 * `build.appId`, which is why setting it here only ever matters in
 * development.
 *
 * The two values are therefore the same string with no derivation between
 * them, which is what appUserModelId.test.ts exists to keep true.
 */
export const APP_USER_MODEL_ID = 'com.jeronimorepetto.dwarfaiminers'

/**
 * Whether this platform needs the identity set from inside the process.
 *
 * A parameter rather than a read of the running OS, so the macOS and Linux
 * answers are assertable on a Windows host (see the `platform-ports` skill).
 * Neither of the other two routes a notification by an application identity at
 * all: macOS keys off the bundle and Linux off the D-Bus name.
 */
export function needsAppUserModelId(platform: Platform): boolean {
  return platform === 'win32'
}
