import type { ProbeCommand } from './processProbe'
import type { CommandRunner } from './unixFocus'

/**
 * The macOS answer to the question `FocusReach` asks on Windows (#329, #367
 * item 2): is this session alone on the thing about to be written into, or is
 * it one tab of a window the panel cannot aim at?
 *
 * The key is the **tty**, and it makes the two platforms' verdicts differ in
 * one way worth stating up front: the Windows one is the result of RAISING a
 * window, so it can only ever describe the foreground. This one raises
 * nothing. A tty names a tab by reference, so a tab is either found or it is
 * not, and the answer is the same whichever tab the person is looking at.
 * There is no foreground requirement here to get wrong.
 *
 * Measured live on 2026-09-18, Terminal.app 470.2 / macOS 26.6.2:
 * `ps -o tty= -p <pid>` answered `ttys001`, and Terminal.app reported
 * `/dev/ttys001, /dev/ttys000` for `tty of every tab of every window` — the
 * same device, printed one way by ps and another by AppleScript, which is the
 * whole of the normalisation below. Full record in `docs/console-hosting.md`.
 *
 * **Terminal.app is the only host measured.** iTerm2, WezTerm, Alacritty,
 * kitty, Ghostty, Hyper and Warp are all in `DARWIN_TERMINAL_HOSTS` and none of
 * them was installed on the machine this was measured on, so nothing here
 * claims to address them. A session in one of those answers `terminal-host` —
 * the honest refusal the Windows port makes for a shared tab strip — rather
 * than a guess at the front tab, exactly as #367 asks.
 */

/** A session whose pid names no terminal device, or one this cannot address. */
export type DarwinConsoleReach =
  { reach: 'own-console'; tty: string } | { reach: 'terminal-host'; error: string }

/**
 * The pid has no controlling terminal — `ps` answered `??`, or could not be
 * asked at all. A headless `claude -p` run is the ordinary case, and it has no
 * tab for anything to be written into.
 */
export const TTY_UNKNOWN =
  'That session is not running in a terminal window this panel can write into.'

/**
 * The tty is real and no Terminal.app tab carries it.
 *
 * One sentence for two facts, because the person can act on both the same way
 * and the panel cannot tell them apart: the session is in a terminal other
 * than Terminal.app (none of which has been measured), or Terminal.app simply
 * has no tab on that device any more.
 */
export const TERMINAL_HOST_UNMEASURED =
  'The panel can only write into Terminal.app, and this session is not in one of its tabs. ' +
  'iTerm2, WezTerm, Alacritty, kitty, Ghostty, Hyper and Warp are not supported yet.'

/**
 * TCC refused this app permission to control Terminal.
 *
 * The one failure that names its own fix, which is why it is worth telling
 * apart from every other osascript error (#367 item 4): nothing is broken, a
 * permission has not been granted, and the person can grant it.
 */
export const AUTOMATION_PERMISSION_DENIED =
  'macOS has not granted this panel permission to control Terminal. Allow it under ' +
  'System Settings > Privacy & Security > Automation, then try again.'

/** osascript's error number for "not authorized to send Apple events". */
const TCC_REFUSED_CODE = '-1743'

/** `ps` for one pid's controlling terminal, header suppressed by the `=` suffix. */
export function buildPidTtyCommand(pid: number): ProbeCommand | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  return { command: 'ps', args: ['-o', 'tty=', '-p', String(pid)] }
}

/**
 * The device path for what `ps -o tty=` printed, or null when there is none.
 *
 * `ps` prints the SHORT name (`ttys001`) and AppleScript the device path
 * (`/dev/ttys001`), so one of them has to be normalised and this is the side
 * that does it. `??` is ps saying the process has no controlling terminal, and
 * anything else unexpected takes the same answer: without a device there is
 * nothing to match, and a match is the only thing that licenses a write.
 */
export function parsePidTty(stdout: string): string | null {
  const name = stdout.trim()
  if (name === '' || name === '??' || /\s/.test(name)) return null
  return name.startsWith('/dev/') ? name : `/dev/${name}`
}

/**
 * osascript for every Terminal.app tab's tty. No user data is interpolated —
 * the script is a constant — so nothing this app read off disk can steer it.
 */
export function buildTerminalTabTtyCommand(): ProbeCommand {
  return {
    command: 'osascript',
    args: ['-e', 'tell application "Terminal" to get tty of every tab of every window']
  }
}

/**
 * The tty list osascript prints: one line, comma-separated, measured on
 * Terminal.app 470.2. A single tab prints one path with no comma at all, which
 * is the same parse.
 */
export function parseTerminalTabTtys(stdout: string): string[] {
  return stdout
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * The verdict for one session's tty against the tabs Terminal.app reported.
 *
 * Pure, so the whole decision is assertable from any host — the shape
 * `planFocusCandidates` and `selectFocusTargetPid` already hold in `focus.ts`.
 */
export function darwinConsoleReachFor(
  tty: string | null,
  tabTtys: readonly string[]
): DarwinConsoleReach {
  if (tty === null) return { reach: 'terminal-host', error: TTY_UNKNOWN }
  if (!tabTtys.includes(tty)) return { reach: 'terminal-host', error: TERMINAL_HOST_UNMEASURED }
  return { reach: 'own-console', tty }
}

/** Whether an osascript failure is TCC refusing Automation permission (#367 item 4). */
export function isAutomationPermissionDenied(error: unknown): boolean {
  return error instanceof Error && error.message.includes(TCC_REFUSED_CODE)
}

/**
 * The runner: resolve a pid to its Terminal.app tab, or to the reason there is
 * none.
 *
 * Two commands at most, and the second is skipped where the first already
 * settled it — a pid with no tty has no tab to look for, and asking Terminal
 * anyway would spend an Apple event (and, the first time, a permission prompt)
 * on a question already answered.
 *
 * Every failure is a refusal rather than a throw, on the same terms the rest of
 * this path holds: the caller falls back to the relay, and a refusal that names
 * its own fix is worth more than one that reads as a bug.
 */
export function createDarwinConsoleReach(run: CommandRunner) {
  return async function reach(pid: number): Promise<DarwinConsoleReach> {
    const ttyCommand = buildPidTtyCommand(pid)
    if (ttyCommand === null) return { reach: 'terminal-host', error: TTY_UNKNOWN }
    let tty: string | null
    try {
      tty = parsePidTty(await run(ttyCommand))
    } catch {
      // An unreadable process list is not a tty, and fail-closed here means the
      // relay carries the message rather than a tab being guessed at.
      return { reach: 'terminal-host', error: TTY_UNKNOWN }
    }
    if (tty === null) return { reach: 'terminal-host', error: TTY_UNKNOWN }
    try {
      return darwinConsoleReachFor(
        tty,
        parseTerminalTabTtys(await run(buildTerminalTabTtyCommand()))
      )
    } catch (error) {
      return {
        reach: 'terminal-host',
        error: isAutomationPermissionDenied(error)
          ? AUTOMATION_PERMISSION_DENIED
          : TERMINAL_HOST_UNMEASURED
      }
    }
  }
}
