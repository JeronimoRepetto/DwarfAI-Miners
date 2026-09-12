import type { Platform } from '../platform/platform'

/**
 * The identity Windows routes a notification by (#316).
 *
 * A dev build has no Start Menu shortcut, so nothing has told Windows who this
 * process is, and the Action Center drops every toast it raises — silently,
 * with no error to catch and nothing in the log. `app.setAppUserModelId` at
 * startup is the whole fix, and it is called from main/index.ts because that is
 * the one file that owns Electron's app object.
 *
 * A PACKAGED build does not need it: the installer writes a shortcut carrying
 * this same identity, derived from `build.appId`. That is why the omission only
 * ever bites in development — the configuration a release is never tested in.
 * Both values are therefore the same string with no derivation between them,
 * which is what appUserModelId.test.ts exists to keep true.
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
