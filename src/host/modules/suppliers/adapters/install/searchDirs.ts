// Where the one resolver looks, per OS (ADR-009 D5; 15 §2.4): PATH × PATHEXT, then the known
// package-manager directories (npm, pnpm, Volta, bun, Scoop shims, WinGet links), then the user's
// `~/.local/bin` (the native installers' default, and the Antigravity installer's, AMENDMENT-13),
// plus one override variable per binary that names its file directly (`DWARFAI_AGY_PATH`).
//
// Every function takes the `Platform`, the environment and the home directory as values, never the
// running OS (R18; skills/platform-ports), so the Windows table is asserted on a Linux host and the
// other way round. The override variable is read from the Host's own environment only: it is never
// put into a child's environment (15 §4 `childEnv`; the resolver's own spawns use `PROBE_ENV_KEYS`).
import { posix, win32 } from 'node:path'

export type Platform = 'win32' | 'darwin' | 'linux'

/** The environment as the Host process has it; on Windows the keys are case-insensitive. */
export type HostEnv = Readonly<Record<string, string | undefined>>

/** Why a directory is searched, from most to least trusted for the person's own choice. */
export type DirKind = 'path' | 'package-manager-dir' | 'login-shell-path'

export interface SearchDir {
  dir: string
  kind: DirKind
}

/** A file named directly by a variable, searched before everything else (15 §2.4 row Antigravity). */
export const OVERRIDE_VARIABLES: Readonly<Record<string, string>> = Object.freeze({
  agy: 'DWARFAI_AGY_PATH'
})

/** What `PATHEXT` is when the variable is missing (the Windows default). */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

export function pathModule(platform: Platform): typeof win32 | typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** A variable's value; Windows matches the name case-insensitively (`Path`, `PATH`). */
export function envValue(env: HostEnv, name: string, platform: Platform): string | undefined {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

/** The directories of a PATH value, in order, without empty entries or surrounding quotes. */
export function pathDirs(pathValue: string | undefined, platform: Platform): string[] {
  if (pathValue === undefined) return []
  return pathValue
    .split(platform === 'win32' ? ';' : ':')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '')
}

/**
 * The file names one binary can have in a directory. Windows: the name with each `PATHEXT`
 * extension (lower-cased: the file system is case-insensitive, and the realpath gives the true
 * case), or the name alone when it already carries one of them; a bare name is never a Windows
 * program. POSIX: the name alone.
 */
export function executableNames(binary: string, env: HostEnv, platform: Platform): string[] {
  if (platform !== 'win32') return [binary]
  const extensions = (envValue(env, 'PATHEXT', platform) ?? DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'))
  const own = extensions.find((ext) => binary.toLowerCase().endsWith(ext))
  return own !== undefined ? [binary] : extensions.map((ext) => `${binary}${ext}`)
}

/**
 * The known package-manager directories, in this order: npm, pnpm, Volta, bun, Scoop shims,
 * WinGet links (the last two exist on Windows only). Each honours the manager's own variable when
 * it is set (`npm_config_prefix`, `PNPM_HOME`, `VOLTA_HOME`, `BUN_INSTALL`, `SCOOP`), else its
 * documented default.
 */
export function packageManagerDirs(env: HostEnv, home: string, platform: Platform): SearchDir[] {
  const path = pathModule(platform)
  const get = (name: string): string | undefined => {
    const value = envValue(env, name, platform)?.trim()
    return value === undefined || value === '' ? undefined : value
  }
  const dirs: string[] = []
  if (platform === 'win32') {
    const appData = get('APPDATA') ?? path.join(home, 'AppData', 'Roaming')
    const localAppData = get('LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local')
    const npmPrefix = get('npm_config_prefix')
    dirs.push(npmPrefix ?? path.join(appData, 'npm'))
    dirs.push(get('PNPM_HOME') ?? path.join(localAppData, 'pnpm'))
    dirs.push(path.join(get('VOLTA_HOME') ?? path.join(localAppData, 'Volta'), 'bin'))
    dirs.push(path.join(get('BUN_INSTALL') ?? path.join(home, '.bun'), 'bin'))
    dirs.push(path.join(get('SCOOP') ?? path.join(home, 'scoop'), 'shims'))
    dirs.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Links'))
  } else {
    const npmPrefix = get('npm_config_prefix')
    if (npmPrefix !== undefined) dirs.push(path.join(npmPrefix, 'bin'))
    dirs.push(path.join(home, '.npm-global', 'bin'), '/usr/local/bin')
    if (platform === 'darwin') dirs.push('/opt/homebrew/bin')
    dirs.push(
      get('PNPM_HOME') ??
        (platform === 'darwin'
          ? path.join(home, 'Library', 'pnpm')
          : path.join(home, '.local', 'share', 'pnpm'))
    )
    dirs.push(path.join(get('VOLTA_HOME') ?? path.join(home, '.volta'), 'bin'))
    dirs.push(path.join(get('BUN_INSTALL') ?? path.join(home, '.bun'), 'bin'))
  }
  return dirs.map((dir) => ({ dir, kind: 'package-manager-dir' }))
}

/** `~/.local/bin`: searched after every other known directory (AMENDMENT-13 order for `agy`). */
export function localBinDir(home: string, platform: Platform): SearchDir {
  return { dir: pathModule(platform).join(home, '.local', 'bin'), kind: 'package-manager-dir' }
}

/** The file a binary's override variable names, or null when it has none or it is unset. */
export function overridePath(binary: string, env: HostEnv, platform: Platform): string | null {
  const variable = OVERRIDE_VARIABLES[binary]
  if (variable === undefined) return null
  const value = envValue(env, variable, platform)?.trim()
  return value === undefined || value === '' ? null : value
}

/**
 * The variables a resolver's own probe child (`--version`, the login shell) may inherit: what a
 * CLI needs to start and find its own files, nothing else. Never an override variable, never a
 * secret (15 §4 `childEnv`; ADR-017).
 */
export const PROBE_ENV_KEYS: readonly string[] = Object.freeze([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL'
])

/** The probe child's environment: the allowlisted variables the Host has, nothing more. */
export function probeEnv(env: HostEnv, platform: Platform): Record<string, string> {
  const out: Record<string, string> = {}
  const taken = new Set<string>()
  for (const key of PROBE_ENV_KEYS) {
    const name = platform === 'win32' ? key.toUpperCase() : key
    const value = envValue(env, key, platform)
    if (value === undefined || taken.has(name)) continue
    taken.add(name)
    out[key] = value
  }
  return out
}
