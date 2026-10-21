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
