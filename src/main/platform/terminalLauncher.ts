import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'
import { currentPlatform, type Platform } from './platform'

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
  /**
   * A file the candidate needs on disk before it is spawned (#635: the macOS launcher). Written
   * exclusively first; removed again if the candidate never starts.
   */
  file?: { path: string; content: string }
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

/*
 * The console title is display text, and since #635 it may be text a person typed (a dwarf's custom
 * name; a base name is a folder's name, no safer). It is only ever a title: these make sure no
 * character of it can act as anything else on the command line it rides on.
 *
 * Control characters and line breaks are never part of a title on any platform: on macOS and Linux
 * they would reach the viewer's OSC title escape, and a line break ends a console line anywhere.
 */
export function displayTitle(title: string): string {
  return title.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim() || FALLBACK_TITLE
}

/*
 * The title of a console whose name is nothing once the above is taken out (a base name of spaces
 * or control characters). Never empty: the Windows viewer's `$Title` is a Mandatory [string], which
 * refuses '' and closes the console at once. "dwarf" is the POSIX viewer's own default title.
 */
export const FALLBACK_TITLE = 'dwarf'

/*
 * Windows Terminal separates its own commands with `;` and documents no escape for one inside an
 * argument (Microsoft Learn, "Windows Terminal command line arguments"), so a `;` in a title could
 * start another wt command ("x ; new-tab cmd /c …"). Each becomes U+FF1B FULLWIDTH SEMICOLON, which
 * reads the same in a title. wt documents no quoting rule for the command line it hands on either,
 * so a `"` becomes U+FF02 FULLWIDTH QUOTATION MARK.
 *
 * Two more were seen live against wt.exe (#635). wt expands environment variables in the command
 * line it hands on: `a%USERNAME%b` reached PowerShell as the account's name, and a variable holding
 * a space split the title into two arguments. So every `%` becomes U+FF05 FULLWIDTH PERCENT SIGN.
 * And wt quotes an argument holding a space without doubling the backslashes before its closing
 * quote, so `Old Watcher\` reached PowerShell as `Old Watcher"`: every `\` becomes U+FF3C FULLWIDTH
 * REVERSE SOLIDUS, rather than doubling the trailing ones, because wt's quoting is undocumented and
 * a rule that depends on it matching CommandLineToArgvW's is a guess. Both Windows routes get the
 * same title, so a dwarf's console reads the same whichever terminal opened it.
 */
function windowsTitle(title: string): string {
  return displayTitle(title)
    .replaceAll(';', '\uFF1B')
    .replaceAll('"', '\uFF02')
    .replaceAll('%', '\uFF05')
    .replaceAll('\\', '\uFF3C')
}

/*
 * PowerShell binds `-Title:<value>` to the parameter whatever the value starts with: a separate
 * value that starts with `-` is read as a parameter name instead (reproduced against powershell.exe
 * -File, #635). One argument, so a title can never be mistaken for a flag of the script.
 */
function powershellTitleArg(title: string): string {
  return '-Title:' + windowsTitle(title)
}

/*
 * wt's own `--title` documents no one-argument form, so a title that starts with `-` could be read
 * as a wt option. Its first character becomes U+2010 HYPHEN instead, which reads the same; only
 * here, since PowerShell's form above needs no such stand-in.
 */
function wtTitleValue(title: string): string {
  const shown = windowsTitle(title)
  return shown.startsWith('-') ? '\u2010' + shown.slice(1) : shown
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
    wtTitleValue(title),
    'powershell',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    viewerScriptPath,
    '-Path',
    transcriptPath,
    powershellTitleArg(title)
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
    powershellTitleArg(title)
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
    displayTitle(options.title),
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

/*
 * macOS (#635): `do script` TYPES its line into Terminal's default login shell, and that shell need
 * not be POSIX. In fish `\'` inside single quotes is an escaped quote, so POSIX quoting lets a name
 * like `\'&calc&\'` run calc; tcsh expands `!` even inside single quotes. So no data rides that
 * line: the viewer's argv goes into a launcher file that /bin/sh reads, where POSIX quoting is
 * exact, and the typed line is only `/bin/sh <launcher>`.
 *
 * The launcher's path is the one thing typed, so it is held to a fixed alphabet that no shell and
 * no AppleScript string treats specially: an absolute path of letters, digits, `/`, `.`, `_`, `+`
 * and `-`. Its name is the app's own (sixteen hex digits); its directory is the temp directory,
 * which the user can set (TMPDIR) to anything, so one outside the alphabet is replaced by /tmp.
 */
const SAFE_LAUNCHER_PATH = /^\/[A-Za-z0-9/._+-]*$/
const LAUNCHER_NAME = /^[0-9a-f]{16}$/
export const DARWIN_LAUNCHER_FALLBACK_DIR = '/tmp'

export function darwinLauncherPath(directory: string, randomHex: string): string {
  if (!LAUNCHER_NAME.test(randomHex)) throw new Error('launcher name must be 16 hex digits')
  const trimmed = directory.replace(/\/+$/, '')
  const safe = SAFE_LAUNCHER_PATH.test(trimmed + '/') ? trimmed : DARWIN_LAUNCHER_FALLBACK_DIR
  return posix.join(safe, `dwarfai-viewer-${randomHex}.sh`)
}

/**
 * The launcher file /bin/sh runs (#635): it removes itself first, so nothing is left on disk once
 * the viewer starts, then becomes the viewer with `exec`, so the viewer keeps Terminal's TTY as its
 * stdin, exactly as when the argv was typed.
 */
export function buildPosixLauncherScript(argv: string[]): string {
  return ['#!/bin/sh', 'rm -f -- "$0"', 'exec ' + quotePosixArgv(argv), ''].join('\n')
}

/**
 * macOS: ask Terminal.app to run the launcher in a new window and come forward. The typed line is
 * `/bin/sh <launcher>` and nothing else; a path outside the fixed alphabet is refused rather than
 * escaped, so it is never typed.
 */
export function buildDarwinTerminalCommand(launcherPath: string): ViewerLaunch {
  if (!SAFE_LAUNCHER_PATH.test(launcherPath)) throw new Error('unsafe launcher path')
  return {
    command: 'osascript',
    args: [
      '-e',
      `tell application "Terminal" to do script "/bin/sh ${launcherPath}"`,
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
  /** Where the macOS launcher file goes (darwinLauncherPath). Required on macOS, unused elsewhere. */
  launcherPath?: string
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
    if (options.launcherPath === undefined) throw new Error('macOS needs a launcher path')
    return [
      {
        ...buildDarwinTerminalCommand(options.launcherPath),
        file: { path: options.launcherPath, content: buildPosixLauncherScript(argv) }
      }
    ]
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
  /** The macOS launcher file's disk (#635); injected for tests, the real temp directory otherwise. */
  launcherFiles?: LauncherFiles
}

/** Where and how the macOS launcher file is written (#635), injected so tests touch no disk. */
export interface LauncherFiles {
  directory(): string
  /** Sixteen lowercase hex digits, the launcher's own name. */
  randomHex(): string
  /** Creates the file exclusively, readable by this user only; rejects if it already exists. */
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

const realLauncherFiles: LauncherFiles = {
  directory: () => tmpdir(),
  randomHex: () => randomBytes(8).toString('hex'),
  write: (path, content) => writeFile(path, content, { flag: 'wx', mode: 0o600 }),
  remove: (path) => rm(path, { force: true })
}

/**
 * Opens a real terminal window tailing `transcriptPath` live, trying this
 * platform's candidates in order until one actually spawns.
 */
export async function launchTranscriptViewer(
  options: LaunchTranscriptViewerOptions
): Promise<boolean> {
  const spawnFn = options.spawn ?? realSpawn
  const platform = options.platform ?? currentPlatform()
  const files = options.launcherFiles ?? realLauncherFiles
  const chain = buildViewerLaunchChain({
    platform,
    title: options.dwarfName,
    viewerScriptPath: options.viewerScriptPath,
    transcriptPath: options.transcriptPath,
    nodePath: options.nodePath ?? process.execPath,
    ...(platform === 'darwin'
      ? { launcherPath: darwinLauncherPath(files.directory(), files.randomHex()) }
      : {})
  })
  for (const candidate of chain) {
    if (candidate.file !== undefined) {
      try {
        await files.write(candidate.file.path, candidate.file.content)
      } catch {
        continue
      }
    }
    if (await trySpawn(spawnFn, candidate.command, candidate.args)) return true
    // It never started, so nothing will run the launcher and remove it.
    if (candidate.file !== undefined) await files.remove(candidate.file.path).catch(() => {})
  }
  return false
}
