// ElectronAutostart: the `AutostartPort` adapter of the window module (05 §3.14; 16 §4.14; ADR-027 item 7). The per-OS
// login entry that starts the app's launch path with `--background` at OS login, written without elevation; its
// per-OS branches live here only (R18). Every detail of what each OS keeps and reports is UNVERIFIED until spike
// S-027-4 passes there (spike register; ADR-027 item 7):
//
// - Windows: a per-user Run value named for the app, through Electron's `app.setLoginItemSettings` (`name`, `path`,
//   `args`); it reads back through `getLoginItemSettings().launchItems`, whose `enabled` is Task Manager's "Startup
//   apps" switch. Electron 44 reads a value's arguments back without its first one (observed on Windows 11 by this
//   issue's OS-lane run: a value `"…\electron.exe" --background x` reads `args: ["x"]`), so the read-back checks the
//   name, the launch path and the switch, and `set(true)` rewrites the value at every call: an entry of this name
//   without `--background` (today's candidate writes one) is repaired at the next start (ADR-027 item 7).
// - macOS: the app's login item (`app.setLoginItemSettings`, `SMAppService` main app service); `status` reads it back,
//   `requires-approval` when the person turned it off in Login Items. A login item takes no arguments, so a login start
//   is told by `wasOpenedAtLogin` (for S-027-4 to confirm).
// - Linux: an XDG autostart entry, `$XDG_CONFIG_HOME/autostart/dwarfai-miners.desktop` (`~/.config` when unset or
//   relative, as the base-directory spec says), written atomically; `X-GNOME-Autostart-enabled=false` or `Hidden=true`
//   is the person's "off".
//
// `get()` is true only when the entry exists, starts this launch path with these arguments, and is not turned off in
// the OS's startup list. `set(true)` writes or repairs the entry but never writes over one the person turned off there
// (DwarfAI never re-enables it over their OS choice); `set(false)` removes it. Electron's setter reports nothing, so a
// write is read back at once and one that did not take throws (`ELOGINITEM`), as a refused file write throws its
// errno: the caller then stores the real state (07 S40.06, S40.07).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { posix } from 'node:path'
import type { LoginItemSettings, LoginItemSettingsOptions, Settings } from 'electron'
import type { AutostartPort } from '../../ports/autostartPort'

/** The part of Electron's `app` the Windows and macOS entries use. */
export interface LoginItemApp {
  setLoginItemSettings(settings: Settings): void
  getLoginItemSettings(options?: LoginItemSettingsOptions): LoginItemSettings
}

/** The synchronous file operations of the XDG entry (Node's `fs` in production; a model in tests). */
export interface AutostartFs {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, encoding: 'utf8'): void
  renameSync(from: string, to: string): void
  mkdirSync(path: string, options: { recursive: true }): unknown
  rmSync(path: string, options: { force: true }): void
}

export const nodeAutostartFs: AutostartFs = {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync
}

export interface ElectronAutostartOptions {
  /** The OS this process runs on (read by the composition root). */
  platform: 'win32' | 'darwin' | 'linux'
  app: LoginItemApp
  /** The channel's stable launch path (ADR-027 item 7: never the Host's versioned copy). */
  launchPath: string
  /** What the entry starts the launch path with (`LOGIN_ENTRY_ARGS`). */
  args: readonly string[]
  /** The app's name: the Run value's name on Windows, the entry's `Name=` on Linux. */
  name: string
  /** The person's home folder and environment (Linux: where the XDG entry goes). */
  home: string
  env: Readonly<Record<string, string | undefined>>
  fs?: AutostartFs
}

/** The basename of the XDG autostart entry (today's candidate writes the same file, so there is one entry). */
export const XDG_AUTOSTART_FILE = 'dwarfai-miners.desktop'

/** What `set` throws when Electron's setter returned but the entry reads back otherwise. */
const NOT_APPLIED = 'ELOGINITEM'

/** The state of the login entry as the OS reports it. */
type EntryState = 'absent' | 'starts' | 'turned-off' | 'other'

function notApplied(on: boolean): Error {
  return Object.assign(new Error(`the login entry could not be ${on ? 'written' : 'removed'}`), {
    code: NOT_APPLIED
  })
}

/**
 * One `Exec=` argument as the Desktop Entry spec reads it: an argument with a reserved character is double-quoted with
 * `"`, `` ` ``, `$` and `\` backslash-escaped inside; then the string escape doubles every backslash, and `%` is `%%`.
 */
function execArgument(argument: string): string {
  const reserved = /[\s"'\\><~|&;$*?#()`]/.test(argument)
  const quoted = reserved ? `"${argument.replace(/["`$\\]/g, (c) => `\\${c}`)}"` : argument
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

/** The `key=value` lines of a desktop entry. */
function desktopKeys(content: string): Map<string, string> {
  const keys = new Map<string, string>()
  for (const line of content.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) keys.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  return keys
}

export class ElectronAutostart implements AutostartPort {
  private readonly fs: AutostartFs

  constructor(private readonly options: ElectronAutostartOptions) {
    this.fs = options.fs ?? nodeAutostartFs
  }

  get(): boolean {
    return this.state() === 'starts'
  }

  set(on: boolean): void {
    const state = this.state()
    if (on) {
      // The person's "off" in the OS list wins: nothing is written over it (ADR-027 item 7).
      if (state === 'turned-off') return
      // Windows cannot read the arguments back (above), so its value is rewritten; elsewhere a right entry is kept.
      if (state === 'starts' && this.options.platform !== 'win32') return
      this.write()
    } else {
      if (state === 'absent') return
      this.remove()
    }
    const after = this.state()
    if (on ? after !== 'starts' : after !== 'absent') throw notApplied(on)
  }

  private state(): EntryState {
    switch (this.options.platform) {
      case 'win32':
        return this.windowsState()
      case 'darwin':
        return this.macState()
      case 'linux':
        return this.linuxState()
    }
  }

  private write(): void {
    const { platform, app, launchPath, args, name } = this.options
    if (platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: true, path: launchPath, args: [...args], name })
    } else if (platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: true })
    } else {
      const file = this.xdgEntry()
      const temp = `${file}.tmp`
      this.fs.mkdirSync(posix.dirname(file), { recursive: true })
      this.fs.writeFileSync(temp, this.desktopEntry(), 'utf8')
      this.fs.renameSync(temp, file)
    }
  }

  private remove(): void {
    const { platform, app, launchPath, args, name } = this.options
    if (platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: false, path: launchPath, args: [...args], name })
    } else if (platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: false })
    } else {
      this.fs.rmSync(this.xdgEntry(), { force: true })
    }
  }

  /** Windows: this app's per-user Run value, matched by name; ours when it starts this launch path. */
  private windowsState(): EntryState {
    const { app, launchPath, args, name } = this.options
    const item = app
      .getLoginItemSettings({ path: launchPath, args: [...args] })
      .launchItems.find((candidate) => candidate.scope === 'user' && candidate.name === name)
    if (item === undefined) return 'absent'
    if (!item.enabled) return 'turned-off'
    return item.path.toLowerCase() === launchPath.toLowerCase() ? 'starts' : 'other'
  }

  /** macOS: the app's login item status. */
  private macState(): EntryState {
    switch (this.options.app.getLoginItemSettings().status) {
      case 'enabled':
        return 'starts'
      case 'requires-approval':
        return 'turned-off'
      default:
        return 'absent'
    }
  }

  /** Linux: the XDG entry file, ours when its `Exec=` is exactly what this app writes. */
  private linuxState(): EntryState {
    let content: string
    try {
      content = this.fs.readFileSync(this.xdgEntry(), 'utf8')
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return 'absent'
      throw error
    }
    const keys = desktopKeys(content)
    if (keys.get('Hidden') === 'true' || keys.get('X-GNOME-Autostart-enabled') === 'false') {
      return 'turned-off'
    }
    return keys.get('Exec') === this.exec() ? 'starts' : 'other'
  }

  private exec(): string {
    return [this.options.launchPath, ...this.options.args].map(execArgument).join(' ')
  }

  private desktopEntry(): string {
    return [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${this.options.name}`,
      `Exec=${this.exec()}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n')
  }

  /** `$XDG_CONFIG_HOME/autostart/…`; a relative or empty value is invalid and treated as unset (XDG base dirs). */
  private xdgEntry(): string {
    const configured = this.options.env.XDG_CONFIG_HOME
    const configHome =
      configured !== undefined && configured.startsWith('/')
        ? configured
        : posix.join(this.options.home, '.config')
    return posix.join(configHome, 'autostart', XDG_AUTOSTART_FILE)
  }
}
