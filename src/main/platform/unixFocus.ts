import { execFile } from 'node:child_process'
import type { ProbeCommand } from '../adapters/processProbe'
import { selectFocusTargetPid, type ProcessRow } from '../focus'

/**
 * Click-to-focus on POSIX systems.
 *
 * The shape mirrors focus.ts: query the process list, walk the ancestor chain
 * from the agent's pid to whatever terminal is hosting it, then ask the window
 * server to bring that process forward. Only the last step is platform
 * specific, and on Linux there is no portable last step at all.
 *
 * Every command here is a pure builder and every parse is a pure function;
 * running them is integration territory (see the support matrix in README).
 */

/** Runs one command and resolves its stdout. */
export type CommandRunner = (command: ProbeCommand) => Promise<string>

/** macOS processes that own a focusable terminal window, lowercased. */
export const DARWIN_TERMINAL_HOSTS: ReadonlySet<string> = new Set([
  'terminal',
  'iterm2',
  'wezterm-gui',
  'alacritty',
  'kitty',
  'ghostty',
  'hyper',
  'warp'
])

/**
 * Linux processes that own a terminal window, lowercased. Only used to decide
 * whether a chain *has* a terminal — Linux focus itself is unsupported (see
 * createUnsupportedFocus).
 */
export const LINUX_TERMINAL_HOSTS: ReadonlySet<string> = new Set([
  'gnome-terminal-server',
  'konsole',
  'xfce4-terminal',
  'xterm',
  'kitty',
  'alacritty',
  'wezterm-gui',
  'terminator',
  'tilix',
  'ghostty'
])

/**
 * `ps` for the whole process table as `pid ppid command`, header suppressed by
 * the `=` suffixes so the output needs no header skipping. Spawned as argv, so
 * no shell ever parses it.
 */
export function buildUnixProcessQueryCommand(): ProbeCommand {
  return { command: 'ps', args: ['-Ao', 'pid=,ppid=,comm='] }
}

/**
 * Parse `ps -Ao pid=,ppid=,comm=` output. macOS prints the executable's full
 * path for `comm` (and app bundles have spaces in it), so everything after the
 * two numeric columns is one command and only its basename is kept. Lines that
 * do not start with two numbers are skipped rather than throwing.
 */
export function parseUnixProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line)
    if (match === null) continue
    const command = match[3] as string
    const basename = command.slice(command.lastIndexOf('/') + 1)
    rows.push({ pid: Number(match[1]), parentPid: Number(match[2]), name: basename })
  }
  return rows
}

/**
 * AppleScript that brings the process with that unix id to the front. Only a
 * number is ever interpolated, so the script cannot be steered by any data
 * this app read off disk.
 */
export function buildDarwinActivateCommand(targetPid: number): ProbeCommand {
  return {
    command: 'osascript',
    args: [
      '-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${targetPid}) to true`
    ]
  }
}

/**
 * The real runner: spawns one command as argv (never through a shell) and
 * rejects on any non-zero exit, which every caller here reads as "this did not
 * happen". Exported because it is the production default for every POSIX
 * adapter that talks to `ps`, `osascript` or the window server.
 */
export function runUnixCommand(probe: ProbeCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(probe.command, probe.args, { timeout: 10_000 }, (error, stdout) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * macOS click-to-focus. Returns false when the chain has no known terminal or
 * the activation failed — the caller then falls back to opening a transcript
 * viewer, exactly as on Windows.
 *
 * Integration-pending: the builders and the chain walk are unit-tested, but
 * System Events also needs the user to have granted Accessibility permission,
 * which cannot be verified from here.
 */
export function createDarwinFocus(run: CommandRunner = runUnixCommand) {
  return async function focus(pid: number): Promise<boolean> {
    try {
      const rows = parseUnixProcessRows(await run(buildUnixProcessQueryCommand()))
      const targetPid = selectFocusTargetPid(rows, pid, DARWIN_TERMINAL_HOSTS)
      if (targetPid === null) return false
      await run(buildDarwinActivateCommand(targetPid))
      return true
    } catch {
      return false
    }
  }
}

/**
 * Focus for platforms with no portable way to raise a window — Linux, where
 * wmctrl/xdotool are X11-only, absent by default, and blocked outright under
 * Wayland. Reporting an honest false sends the click straight to the
 * transcript-viewer fallback instead of hanging on a tool that is not there.
 */
export function createUnsupportedFocus() {
  return async function focus(_pid: number): Promise<boolean> {
    return false
  }
}
