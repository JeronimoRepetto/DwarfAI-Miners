// How UI main asks the desktop for a terminal running a console target's command (ADR-031 items 2,
// 4; ADR-029 #8; 05 R17; 18 §4.2 T-11): one ORDERED chain of candidates per OS, each an argv
// array spawned with `shell: false`; the first that starts wins. Pure: the spawning is
// TerminalConsoleRaiser's.
//
// Candidate (21 §6): `src/main/platform/terminalLauncher.ts` at the found tree, ADAPTED. Its macOS
// launcher-file rule (`darwinLauncherPath`, `buildPosixLauncherScript`, `quotePosixArgv`, the
// fixed-alphabet `do script` line, #635) and its Linux terminal table are kept as they are; what
// it ran is replaced: it tailed a transcript with a shell script, this runs the console viewer on
// the versioned-copy executable. Its Windows Terminal route is dropped: wt expands `%VAR%` and
// splits on `;` in the command line it hands on (#635), and the viewer's argv carries paths
// (the executable, the viewer script, the token file), which cannot be rewritten as a title can.
//
// - The command line carries no data of any kind but those paths: never a dwarf name, a mine path
//   or a token (T-11; ADR-003 item 12). The token stays in its file.
// - The viewer runs on Electron as Node: ELECTRON_RUN_AS_NODE=1 is set for it (not a secret). On
//   Windows, PowerShell runs a FIXED program (`-EncodedCommand`, no data in it) that reads the three
//   paths from environment variables the raiser sets and starts the viewer with them as its argv;
//   PowerShell is console-subsystem, so Windows gives it a console window of its own. On macOS the
//   argv goes into a launcher file /bin/sh reads (`env ELECTRON_RUN_AS_NODE=1 …`), on Linux it
//   follows the terminal's run-this flag behind `env ELECTRON_RUN_AS_NODE=1`.
import { posix } from 'node:path'

/** One candidate way to open a terminal running the command, as an argv pair. */
export interface TerminalLaunch {
  command: string
  args: string[]
  /** Variables the candidate adds to the spawn's environment (never a secret). */
  env?: Readonly<Record<string, string>>
  /** A file the candidate needs on disk before it is spawned (the macOS launcher). */
  file?: { path: string; content: string }
}

/** The command a console target names (ADR-031 item 1). */
export interface ConsoleCommand {
  program: string
  args: readonly string[]
  cwd: string
}

/** The variable that makes the Electron executable run the viewer script as Node. */
export const RUN_AS_NODE = { ELECTRON_RUN_AS_NODE: '1' } as const

/** Windows: the variables the fixed PowerShell program reads (paths only, never the token). */
export const WINDOWS_PROGRAM_VARIABLE = 'DWARFAI_CONSOLE_PROGRAM'
export const WINDOWS_ARGUMENT_VARIABLES = [
  'DWARFAI_CONSOLE_ARG_1',
  'DWARFAI_CONSOLE_ARG_2'
] as const

/**
 * The one PowerShell program of the Windows candidate: fixed text, no data in it. It starts the
 * program the variables name with the two arguments they name, as an argv (PowerShell's call
 * operator), and leaves with its exit code.
 */
export const WINDOWS_CONSOLE_PROGRAM = [
  "$env:ELECTRON_RUN_AS_NODE = '1'",
  `& $env:${WINDOWS_PROGRAM_VARIABLE} $env:${WINDOWS_ARGUMENT_VARIABLES[0]} $env:${WINDOWS_ARGUMENT_VARIABLES[1]}`,
  'exit $LASTEXITCODE'
].join('; ')

/** PowerShell's `-EncodedCommand` form of a program: base64 of its UTF-16LE text. */
export function encodePowerShell(program: string): string {
  return Buffer.from(program, 'utf16le').toString('base64')
}

/**
 * Quote an argv into one POSIX shell command line (kept from terminalLauncher.ts): single quotes
 * make every character literal, and only a single quote itself is escaped (`'\''`).
 */
export function quotePosixArgv(argv: readonly string[]): string {
  return argv.map((argument) => `'${argument.replaceAll("'", `'\\''`)}'`).join(' ')
}

// macOS (#635, kept from terminalLauncher.ts): `do script` TYPES its line into Terminal's login
// shell, which need not be POSIX, so no data rides that line. The argv goes into a launcher file
// /bin/sh reads, where POSIX quoting is exact, and the typed line is only `/bin/sh <launcher>`. Its
// path is held to a fixed alphabet; a temp directory outside it is replaced by /tmp.
const SAFE_LAUNCHER_PATH = /^\/[A-Za-z0-9/._+-]*$/
const LAUNCHER_NAME = /^[0-9a-f]{16}$/
export const DARWIN_LAUNCHER_FALLBACK_DIR = '/tmp'

export function darwinLauncherPath(directory: string, randomHex: string): string {
  if (!LAUNCHER_NAME.test(randomHex)) throw new Error('launcher name must be 16 hex digits')
  const trimmed = directory.replace(/\/+$/, '')
  const safe = SAFE_LAUNCHER_PATH.test(trimmed + '/') ? trimmed : DARWIN_LAUNCHER_FALLBACK_DIR
  return posix.join(safe, `dwarfai-viewer-${randomHex}.sh`)
}

/** The launcher /bin/sh runs: it removes itself, then becomes the command with `exec`. */
export function buildPosixLauncherScript(argv: readonly string[]): string {
  return ['#!/bin/sh', 'rm -f -- "$0"', 'exec ' + quotePosixArgv(argv), ''].join('\n')
}

/** Terminal.app runs the launcher in a new window and comes forward; the path is never escaped. */
export function buildDarwinTerminalCommand(launcherPath: string): TerminalLaunch {
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

/** Linux terminals, most portable first (kept from terminalLauncher.ts). */
export const LINUX_TERMINALS: readonly string[] = [
  'x-terminal-emulator',
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'xterm'
]

/** The flag each Linux terminal reads as "everything after this is the command to run". */
export function linuxRunFlag(terminal: string): string {
  return terminal === 'gnome-terminal' ? '--' : terminal === 'xfce4-terminal' ? '-x' : '-e'
}

/** The viewer's argv behind `env`, so the variable reaches it whatever the terminal passes on. */
function posixArgv(command: ConsoleCommand): string[] {
  return ['env', 'ELECTRON_RUN_AS_NODE=1', command.program, ...command.args]
}

export interface ConsoleLaunchOptions {
  platform: NodeJS.Platform
  command: ConsoleCommand
  /** Where the macOS launcher goes (darwinLauncherPath). Required on macOS, unused elsewhere. */
  launcherPath?: string
}

/** The ordered candidates for one OS; the raiser tries them in order and stops at the first that starts. */
export function consoleLaunchChain(options: ConsoleLaunchOptions): TerminalLaunch[] {
  const { command } = options
  if (options.platform === 'win32') {
    if (command.args.length !== WINDOWS_ARGUMENT_VARIABLES.length) {
      throw new Error('a console command carries the viewer script and the token file path')
    }
    return [
      {
        command: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encodePowerShell(WINDOWS_CONSOLE_PROGRAM)
        ],
        env: {
          ...RUN_AS_NODE,
          [WINDOWS_PROGRAM_VARIABLE]: command.program,
          [WINDOWS_ARGUMENT_VARIABLES[0]]: command.args[0] as string,
          [WINDOWS_ARGUMENT_VARIABLES[1]]: command.args[1] as string
        }
      }
    ]
  }
  if (options.platform === 'darwin') {
    if (options.launcherPath === undefined) throw new Error('macOS needs a launcher path')
    return [
      {
        ...buildDarwinTerminalCommand(options.launcherPath),
        env: RUN_AS_NODE,
        file: {
          path: options.launcherPath,
          content: buildPosixLauncherScript(posixArgv(command))
        }
      }
    ]
  }
  return LINUX_TERMINALS.map((terminal) => ({
    command: terminal,
    args: [linuxRunFlag(terminal), ...posixArgv(command)],
    env: RUN_AS_NODE
  }))
}
