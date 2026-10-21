// What the windowing of this session allows (ADR-025 items 1, 6; 14 §2.2 A-N24 `getWindowingLimits`; UC-068;
// NFR-PLAT-04, NFR-PLAT-05). Pure.
//
// - Docking (a mode window placed where the app asks: Veta flush against a work-area edge, the docked Panel) holds while
//   the bounds asked are the bounds the OS applied (`getBounds()` read back after `setBounds`, ADR-025 item 6).
// - Always-on-top holds on Windows, macOS and X11 (Linux started with `--ozone-platform=x11` when XWayland exists is
//   X11 to the app). The level each OS keeps above full-screen apps is S-025-2's; until it is recorded the ADR-025
//   item 1 proposal stands, and a level the OS refuses fails the same visible way on every OS (NFR-PLAT-04).
// - Native Wayland: the compositor places every window and Electron cannot set always-on-top, so neither is available,
//   whatever the bounds read back. The fallback is the same for the Panel and Veta (NFR-PLAT-05).
// - A Linux session the probe cannot name fails closed, as native Wayland.

/** The three operating systems the app runs on (NFR-PLAT-01). */
export type WindowingPlatform = 'win32' | 'darwin' | 'linux'

/**
 * The Linux graphical session the app runs in: `x11`; `xwayland` (a Wayland session, the app started on X11 through
 * XWayland, ADR-025 item 6); `wayland` (native Wayland, no XWayland); `none` (no session the probe can name).
 */
export type LinuxSession = 'x11' | 'xwayland' | 'wayland' | 'none'

/** The session type on Linux; `null` on Windows and macOS, which have one windowing system each. */
export type WindowingSession = LinuxSession | null

/** A-N24's answer (14 §2.2). */
export interface WindowingLimits {
  readonly dockingAvailable: boolean
  readonly alwaysOnTopAvailable: boolean
}

export function windowingLimits(
  platform: WindowingPlatform,
  session: WindowingSession,
  boundsApplied: boolean
): WindowingLimits {
  if (platform === 'linux' && session !== 'x11' && session !== 'xwayland') {
    return { dockingAvailable: false, alwaysOnTopAvailable: false }
  }
  return { dockingAvailable: boundsApplied, alwaysOnTopAvailable: true }
}
