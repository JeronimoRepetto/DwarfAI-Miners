import { spawn as nodeSpawn } from 'node:child_process'
import { posix, win32 } from 'node:path'
import { currentPlatform, type Platform } from './platform/platform'

/**
 * Click-to-focus fallback: when no existing window can be brought forward
 * (see focus.ts) — because the session is headless, or focusing failed —
 * open a real terminal window that tails the dwarf's transcript live.
 *
 * Every platform runs the same viewer logic against the same transcript, in
 * the language its shell speaks: resources/dwarf-feed-viewer.ps1 on Windows,
 * resources/dwarf-feed-viewer.sh on macOS and Linux. What differs is how you
 * ask the desktop for a terminal window, which is why each platform
 * contributes an ORDERED chain of candidate commands: the first one that
 * actually spawns wins, and the rest exist because no single terminal is
 * guaranteed to be installed. Command construction is pure and unit-tested;
 * actually spawning a process is integration-only.
 */

/** One candidate way to open a terminal window, as an argv pair. */
export interface ViewerLaunch {
  command: string
  args: string[]
}

export interface ViewerPathOptions {
  isPackaged: boolean
  /** process.resourcesPath — used only when packaged. */
  resourcesPath: string
  /** app.getAppPath() (the project root pre-package, i.e. in dev). */
  appPath: string
}

/** The viewer script each platform's shell can run. */
export function viewerScriptName(platform: Platform): string {
  return platform === 'win32' ? 'dwarf-feed-viewer.ps1' : 'dwarf-feed-viewer.sh'
}

/**
 * Where the viewer script lives: alongside `resources/` at the project root in
 * dev, or directly under `process.resourcesPath` once packaged (see
 * `build.extraResources` in package.json, which copies resources/* there).
 */
export function resolveViewerScriptPath(
  options: ViewerPathOptions,
  platform: Platform = currentPlatform()
): string {
  const join = platform === 'win32' ? win32.join : posix.join
  const name = viewerScriptName(platform)
  return options.isPackaged
    ? join(options.resourcesPath, name)
    : join(options.appPath, 'resources', name)
}

/** Argv for `wt.exe`: a titled new tab (reuses the most recently used window, or opens one). */
export function buildWtArgs(
  title: string,
  viewerScriptPath: string,
  transcriptPath: string
): string[] {
  return [
    '-w',
    '-1',
    'new-tab',
    '--title',
    title,
    'powershell',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    viewerScriptPath,
    '-Path',
    transcriptPath,
    '-Title',
    title
  ]
}

/**
 * Argv for a direct `powershell.exe` spawn, used when Windows Terminal isn't
 * installed. Electron's main process has no console of its own, so Windows
 * gives a spawned console-subsystem process (powershell.exe) a fresh console
 * window automatically — no extra `Start-Process` hop needed.
 */
export function buildFallbackArgs(
  title: string,
  viewerScriptPath: string,
  transcriptPath: string
): string[] {
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    viewerScriptPath,
    '-Path',
    transcriptPath,
    '-Title',
    title
  ]
}

export interface PosixViewerOptions {
  title: string
  viewerScriptPath: string
  transcriptPath: string
  /**
   * The Node-capable binary the viewer's JSONL formatter runs on — normally
   * process.execPath. An Electron binary runs as plain Node when
   * ELECTRON_RUN_AS_NODE is set, which the script does; a real `node` ignores
   * the variable. See resources/dwarf-feed-viewer.sh.
   */
  nodePath: string
}

/**
 * The command line that runs the POSIX viewer. Invoked through `sh` rather
 * than executed directly, so the shipped script never needs an execute bit
 * that packaging (or a zip round-trip) could drop.
 */
export function buildPosixViewerArgv(options: PosixViewerOptions): string[] {
  return [
    'sh',
    options.viewerScriptPath,
    '--path',
    options.transcriptPath,
    '--title',
    options.title,
    '--node',
    options.nodePath
  ]
}

/**
 * Quote an argv into one POSIX shell command line. Single quotes make every
 * character literal, and the only thing that has to be escaped is a single
 * quote itself — the `'\''` idiom closes the literal, emits an escaped quote,
 * and reopens it.
 */
export function quotePosixArgv(argv: string[]): string {
  return argv.map((argument) => `'${argument.replaceAll("'", `'\\''`)}'`).join(' ')
}

/**
 * macOS: ask Terminal.app to run the viewer in a new window and come forward.
 * `do script` takes a shell command line, so the argv is quoted for the shell
 * first and then escaped for the AppleScript string literal — two layers,
 * because there are two parsers.
 */
export function buildDarwinTerminalCommand(argv: string[]): ViewerLaunch {
  const commandLine = quotePosixArgv(argv).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return {
    command: 'osascript',
    args: [
      '-e',
      `tell application "Terminal" to do script "${commandLine}"`,
      '-e',
      'tell application "Terminal" to activate'
    ]
  }
}

/**
 * Linux terminals, most portable first. `x-terminal-emulator` is Debian's
 * alternatives symlink and is the only name that is even close to standard;
 * everything after it is a named desktop-environment terminal, tried in turn
 * because none of them is guaranteed to exist.
 */
export const LINUX_TERMINALS: readonly string[] = [
  'x-terminal-emulator',
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'xterm'
]

/**
 * The flag each Linux terminal uses to mean "everything after this is the
 * command to run". gnome-terminal dropped `-e` in favour of `--`, and
 * xfce4-terminal wants `-x`; the rest still take `-e`.
 *
 * No terminal is given a title flag: the viewer script sets the window title
 * itself with an OSC escape, which works in all of them and keeps this table
 * to one dimension.
 */
export function buildLinuxTerminalCommand(terminal: string, argv: string[]): ViewerLaunch {
  const flag = terminal === 'gnome-terminal' ? '--' : terminal === 'xfce4-terminal' ? '-x' : '-e'
  return { command: terminal, args: [flag, ...argv] }
}

export interface ViewerLaunchOptions extends PosixViewerOptions {
  platform: Platform
}

/**
 * The ordered candidates for opening a viewer window on one platform. The
 * caller tries them in order and stops at the first that spawns.
 */
export function buildViewerLaunchChain(options: ViewerLaunchOptions): ViewerLaunch[] {
  const { title, viewerScriptPath, transcriptPath } = options
  if (options.platform === 'win32') {
    return [
      { command: 'wt.exe', args: buildWtArgs(title, viewerScriptPath, transcriptPath) },
      {
        command: 'powershell.exe',
        args: buildFallbackArgs(title, viewerScriptPath, transcriptPath)
      }
    ]
  }
  const argv = buildPosixViewerArgv(options)
  if (options.platform === 'darwin') {
    return [buildDarwinTerminalCommand(argv)]
  }
  return LINUX_TERMINALS.map((terminal) => buildLinuxTerminalCommand(terminal, argv))
}

/** Minimal shape of node:child_process's ChildProcess, injected so tests never touch a real process. */
export interface SpawnedProcess {
  once(event: 'error' | 'spawn', listener: (error?: Error) => void): void
  unref(): void
}

export type SpawnFn = (command: string, args: string[]) => SpawnedProcess

function realSpawn(command: string, args: string[]): SpawnedProcess {
  return nodeSpawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false })
}

/**
 * True once the process actually starts (the `spawn` event), false on any
 * error (e.g. ENOENT for a missing wt.exe). Detached + unref'd so the viewer
 * window survives independently of this app (it keeps running in the tray,
 * but there is no reason to tie the two lifecycles together).
 */
function trySpawn(spawnFn: SpawnFn, command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let child: SpawnedProcess
    try {
      child = spawnFn(command, args)
    } catch {
      resolve(false)
      return
    }
    child.once('error', () => {
      if (settled) return
      settled = true
      resolve(false)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve(true)
    })
  })
}

export interface LaunchTranscriptViewerOptions {
  dwarfName: string
  transcriptPath: string
  viewerScriptPath: string
  platform?: Platform
  /** Node-capable binary for the POSIX viewer; defaults to this process's. */
  nodePath?: string
  /** Injected for tests; defaults to node:child_process.spawn. */
  spawn?: SpawnFn
}

/**
 * Opens a real terminal window tailing `transcriptPath` live, trying this
 * platform's candidates in order until one actually spawns.
 */
export async function launchTranscriptViewer(
  options: LaunchTranscriptViewerOptions
): Promise<boolean> {
  const spawnFn = options.spawn ?? realSpawn
  const chain = buildViewerLaunchChain({
    platform: options.platform ?? currentPlatform(),
    title: options.dwarfName,
    viewerScriptPath: options.viewerScriptPath,
    transcriptPath: options.transcriptPath,
    nodePath: options.nodePath ?? process.execPath
  })
  for (const candidate of chain) {
    if (await trySpawn(spawnFn, candidate.command, candidate.args)) return true
  }
  return false
}
