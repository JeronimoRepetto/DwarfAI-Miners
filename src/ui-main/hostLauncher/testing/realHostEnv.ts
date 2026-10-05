// The environment of a real Host started by a test (realHost.ts; 17 §5.3: a test never depends on
// the machine it runs on). The Host detects the person's installed provider CLIs at start (ADR-009
// D5, ISSUE-159) through the CliInstallResolver, which searches PATH, the package-manager folders
// derived from the home and tool variables, `~/.local/bin` and, on macOS and Linux, the login
// shell's PATH. A test Host must never find, let alone run `--version` on, a real provider CLI, so
// it gets:
//
// - a PATH of the system folders only. The Host runs on the Electron executable by its path and
//   calls every system tool by absolute path (whoami, taskkill, ps, sysctl, xattr), so PATH only
//   keeps the system folders a POSIX login shell expects;
// - a home of its own (HOME, USERPROFILE, APPDATA, LOCALAPPDATA, the XDG data folders), so every
//   package-manager folder derived from it is empty;
// - none of the variables naming a person's tool folders (PNPM_HOME, VOLTA_HOME, BUN_INSTALL,
//   SCOOP, npm_config_prefix), the provider path overrides (DWARFAI_AGY_PATH) or their SHELL.
//
// The test's own overrides (the case's HOME and XDG_RUNTIME_DIR, which the endpoint is derived
// from on POSIX) are applied last. Windows variable names are matched without case.
//
// Not covered by the environment: the fixed POSIX folders the resolver always searches
// (`/usr/local/bin`, and `/opt/homebrew/bin` on macOS) and the folders the system login profile
// (`/etc/profile`) adds. A CLI installed there is still resolved on a macOS or Linux machine.
import path from 'node:path'

export interface IsolatedHostEnvOptions {
  /** The test process's environment (`process.env`). */
  base: Readonly<Record<string, string | undefined>>
  /** This Host's own home folder, an empty per-Host temp folder. */
  home: string
  platform: NodeJS.Platform
  /** The case's own values, applied last (HOME, XDG_RUNTIME_DIR). */
  overrides?: Readonly<Record<string, string>>
}

/** Every variable replaced or removed, upper case (Windows names are case-insensitive). */
const REMOVED = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'PNPM_HOME',
  'VOLTA_HOME',
  'BUN_INSTALL',
  'SCOOP',
  'NPM_CONFIG_PREFIX',
  'DWARFAI_AGY_PATH',
  'SHELL'
])

export function isolatedHostEnv(options: IsolatedHostEnvOptions): Record<string, string> {
  const env: Record<string, string> = {}
  let systemRoot = 'C:\\Windows'
  for (const [key, value] of Object.entries(options.base)) {
    if (value === undefined) continue
    if (key.toUpperCase() === 'SYSTEMROOT') systemRoot = value
    if (!REMOVED.has(key.toUpperCase())) env[key] = value
  }
  const { home } = options
  if (options.platform === 'win32') {
    const root = systemRoot.replace(/[\\/]+$/, '')
    env.PATH = `${root}\\System32;${root}`
    env.USERPROFILE = home
    env.HOME = home
    env.APPDATA = path.win32.join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = path.win32.join(home, 'AppData', 'Local')
  } else {
    env.PATH = '/usr/bin:/bin'
    env.HOME = home
    env.XDG_CONFIG_HOME = path.posix.join(home, '.config')
    env.XDG_DATA_HOME = path.posix.join(home, '.local', 'share')
    env.XDG_CACHE_HOME = path.posix.join(home, '.cache')
    env.XDG_STATE_HOME = path.posix.join(home, '.local', 'state')
  }
  return { ...env, ...options.overrides }
}
