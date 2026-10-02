// The build facts the migration runner's dev guard needs (ADR-005 item 6; 09 §1; FM-107): which
// kind of build this Host is, and where the RELEASE build keeps its hostDataDir.
//
// - The hostDataDir is the UI's `app.getPath('userData')` + `/host` (ADR-002 D2), and userData
//   follows the product name (`DwarfAI-Miners`) under Electron's `appData` folder. The Host runs
//   without Electron (ADR-002 D1), so it rebuilds the release build's default from the same OS
//   rule Electron applies: `%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
//   `$XDG_CONFIG_HOME` (when absolute) or `~/.config` on Linux. A dev build that finds its
//   database under that folder refuses to migrate it.
// - A packaged Host is the release build; an unpackaged one (run from a checkout) is a dev build,
//   which uses its own data directory (`DwarfAI-dev`, ADR-005 item 6).
// R18: the OS branching lives here, under host/platform, with the platform passed in.
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** The product name, which names Electron's userData folder (package.json `productName`). */
export const PRODUCT_NAME = 'DwarfAI-Miners'

export type ReleasePlatform = 'win32' | 'darwin' | 'linux'

export interface ReleaseDataDirFacts {
  platform: ReleasePlatform
  env: Readonly<Record<string, string | undefined>>
  /** The user's home folder. */
  home: string
}

function appDataDir(facts: ReleaseDataDirFacts): string {
  if (facts.platform === 'win32') {
    const appData = facts.env['APPDATA']
    return appData !== undefined && appData !== ''
      ? appData
      : win32.join(facts.home, 'AppData', 'Roaming')
  }
  if (facts.platform === 'darwin') return posix.join(facts.home, 'Library', 'Application Support')
  const xdg = facts.env['XDG_CONFIG_HOME']
  return xdg !== undefined && posix.isAbsolute(xdg) ? xdg : posix.join(facts.home, '.config')
}

/** The release build's hostDataDir on this OS (ADR-002 D2). */
export function releaseHostDataDir(facts: ReleaseDataDirFacts): string {
  const join = facts.platform === 'win32' ? win32.join : posix.join
  return join(appDataDir(facts), PRODUCT_NAME, 'host')
}

/** The release build's hostDataDir for this process's OS, environment and home folder. */
export function thisProcessReleaseHostDataDir(): string {
  return releaseHostDataDir({ platform: thisPlatform(), env: process.env, home: homedir() })
}

function thisPlatform(): ReleasePlatform {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
}

/** A packaged Host is the release build; anything else is a dev build (ADR-005 item 6). */
export function buildKindOf(paths: { isPackaged: boolean }): 'release' | 'dev' {
  return paths.isPackaged ? 'release' : 'dev'
}

/** The facts the Host's log folder is read from (ADR-026 item 1). */
export interface HostLogDirFacts extends ReleaseDataDirFacts {
  isPackaged: boolean
  /** DWARFAI_HOST_DATA_DIR, or null when the UI handed none. */
  hostDataDir: string | null
}

/** The data directory of development builds (ADR-005 item 6; the UI's `dataDirectory.ts`). */
export const DEV_DATA_DIR_NAME = 'DwarfAI-dev'

/**
 * The Host's log folder (ADR-026 item 1; 19 §3): `<userData>/logs/`, where userData is the folder
 * holding the hostDataDir the UI handed over. A Host started without DWARFAI_HOST_DATA_DIR still
 * logs its NO_DATA_DIR refusal: into the documented folder of its build, the release userData for a
 * packaged Host and `DwarfAI-dev` beside it for a dev one, so dev logs never mix with a release's
 * (19 §3).
 */
export function hostLogDir(facts: HostLogDirFacts): string {
  const path = facts.platform === 'win32' ? win32 : posix
  if (facts.hostDataDir !== null) return path.join(path.dirname(facts.hostDataDir), 'logs')
  const userData = facts.isPackaged ? PRODUCT_NAME : DEV_DATA_DIR_NAME
  return path.join(appDataDir(facts), userData, 'logs')
}

/** hostLogDir for this process's OS, environment and home folder. */
export function thisProcessHostLogDir(
  facts: Pick<HostLogDirFacts, 'isPackaged' | 'hostDataDir'>
): string {
  return hostLogDir({ ...facts, platform: thisPlatform(), env: process.env, home: homedir() })
}
