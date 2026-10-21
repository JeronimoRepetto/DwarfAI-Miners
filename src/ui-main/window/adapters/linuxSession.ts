// The Linux session probe of the window module (ADR-025 item 6; UC-068; NFR-PLAT-05): which graphical session UI main
// runs in, read from the variables the session exports, never from a command (R17). It is read once at the start,
// before Electron picks its Ozone platform, so the answer is the session the app was started in.
//
// - `DISPLAY` names an X server: plain X11, or XWayland inside a Wayland session (`WAYLAND_DISPLAY` or
//   `XDG_SESSION_TYPE=wayland` beside it). Where XWayland exists the app starts on X11 (`--ozone-platform=x11`), so
//   positioning and always-on-top work as on X11.
// - `WAYLAND_DISPLAY` alone is native Wayland: the compositor places every window (ADR-025 item 6 fallback).
// - Neither: no session the probe can name (`none`), which the windowing limits treat as native Wayland (fail closed).
//
// Which session types keep click-through forwarding and transparent compositing is S-025-3's to record on real
// machines (17 §1.13); nothing here depends on it.
import type { LinuxSession } from '../domain/windowingLimits'

/** The session variables the probe reads (a subset of `process.env`). */
export type SessionEnv = Readonly<Record<string, string | undefined>>

const set = (value: string | undefined): boolean => value !== undefined && value !== ''

/** The Linux session the variables describe. */
export function probeLinuxSession(env: SessionEnv): LinuxSession {
  const wayland = set(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === 'wayland'
  if (set(env.DISPLAY)) return wayland ? 'xwayland' : 'x11'
  return set(env.WAYLAND_DISPLAY) ? 'wayland' : 'none'
}

/** The Ozone platform UI main starts Electron on: X11 where XWayland exists, else Electron's own choice. */
export function ozonePlatformFor(session: LinuxSession): 'x11' | null {
  return session === 'xwayland' ? 'x11' : null
}

const OZONE = '--ozone-platform='

/** The `--ozone-platform` value on the command line, or `null` when none was passed. */
function ozoneSwitch(argv: readonly string[]): string | null {
  const found = argv.find((arg) => arg.startsWith(OZONE))
  return found === undefined ? null : found.slice(OZONE.length)
}

/**
 * ADR-025 item 6: the arguments to relaunch with when a Linux start on a Wayland session with XWayland lacks
 * `--ozone-platform=x11`; `null` when the start stays as it is. Electron picks its display backend before the main
 * script runs, so the switch works only on the command line (Electron docs, command-line switches,
 * `--ozone-platform`; `app.commandLine.appendSwitch` is too late). A command line that names any Ozone platform is
 * left alone, so a relaunch never relaunches again.
 */
export function ozoneRelaunchArgs(
  platform: 'win32' | 'darwin' | 'linux',
  env: SessionEnv,
  argv: readonly string[]
): string[] | null {
  if (platform !== 'linux' || ozoneSwitch(argv) !== null) return null
  const platformWanted = ozonePlatformFor(probeLinuxSession(env))
  return platformWanted === null ? null : [...argv, `${OZONE}${platformWanted}`]
}

/**
 * The session the app runs in, counting the backend Electron chose: the command line's `--ozone-platform`, or with
 * none, Wayland when both servers are reachable on a session that says `wayland` (Electron docs, the same switch).
 */
export function runningLinuxSession(env: SessionEnv, argv: readonly string[]): LinuxSession {
  const offered = probeLinuxSession(env)
  if (offered !== 'xwayland') return offered
  const chosen = ozoneSwitch(argv)
  if (chosen === 'x11') return 'xwayland'
  if (chosen === 'wayland') return 'wayland'
  return env.XDG_SESSION_TYPE === 'wayland' && set(env.WAYLAND_DISPLAY) ? 'wayland' : 'xwayland'
}
