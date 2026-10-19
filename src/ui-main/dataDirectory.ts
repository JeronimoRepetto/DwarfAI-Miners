// The folder the rebuilt UI and its Host keep their data in (ADR-005 item 6; 09 §1; ADR-002 D2; 13 FM-107).
//
// - A packaged build is the release build: Electron's userData, named after the product (`DwarfAI-Miners`).
// - A development or preview build (unpackaged) MUST use a data directory of its own, `DwarfAI-dev` (ADR-005 item 6,
//   09 §1). Run from a checkout, Electron still names userData after the product, so such a build would share the
//   installed app's folder, and its Host rightly refuses to migrate a database there (`DEV_BUILD_ON_RELEASE_DATA`).
//   When userData is that release folder, the build uses `DwarfAI-dev` beside it under Electron's appData. The
//   endpoint rule names the same folder (`endpoint.ts`: the folder holding hostDataDir, `DwarfAI-dev` for a dev build).
// - A userData chosen on the command line (`--user-data-dir`: the E2E and OS-lane temp profiles, 17 §1.9) is not the
//   release folder and is kept as it is.
//
// The folder holds `host/` (the hostDataDir), `logs/` (the UI's log segments, beside the Host's, ADR-026 item 1) and
// the UI preference files (ADR-024 item 1). Today's runtime is not routed through it: until cut 5 it keeps Electron's
// userData, so a person's legacy board is the same in every build (ISSUE-056 decision).
import { posix, win32 } from 'node:path'

/** The product name Electron names the release userData after (package.json `productName`). */
export const PRODUCT_NAME = 'DwarfAI-Miners'

/** The data directory of development and preview builds (ADR-005 item 6). */
export const DEV_DATA_DIR_NAME = 'DwarfAI-dev'

export interface UiDataDirectoryFacts {
  platform: 'win32' | 'darwin' | 'linux'
  /** `app.isPackaged`: a packaged build is the release build. */
  isPackaged: boolean
  /** Electron's `app.getPath('appData')`, the folder userData defaults into. */
  appData: string
  /** Electron's `app.getPath('userData')`. */
  userData: string
}

export function uiDataDirectory(facts: UiDataDirectoryFacts): string {
  if (facts.isPackaged) return facts.userData
  const path = facts.platform === 'win32' ? win32 : posix
  const releaseFolder = path.join(facts.appData, PRODUCT_NAME)
  return samePath(facts.platform, facts.userData, releaseFolder)
    ? path.join(facts.appData, DEV_DATA_DIR_NAME)
    : facts.userData
}

/** Whether two absolute paths name one folder as the OS compares them (case-insensitive on Windows and macOS). */
function samePath(platform: UiDataDirectoryFacts['platform'], a: string, b: string): boolean {
  const path = platform === 'win32' ? win32 : posix
  const canonical = (value: string): string => {
    const resolved = path.resolve(value)
    return platform === 'linux' ? resolved : resolved.toLowerCase()
  }
  return canonical(a) === canonical(b)
}
