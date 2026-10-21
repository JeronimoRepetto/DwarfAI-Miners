// layer: L1
import { describe, expect, it } from 'vitest'
import { windowingLimits, type WindowingPlatform, type WindowingSession } from './windowingLimits'

describe('windowingLimits (ADR-025 items 1, 6; 14 §2.2 A-N24; UC-068)', () => {
  const both = { dockingAvailable: true, alwaysOnTopAvailable: true }
  const neither = { dockingAvailable: false, alwaysOnTopAvailable: false }
  const unplacedOnly = { dockingAvailable: false, alwaysOnTopAvailable: true }
  const rows: [WindowingPlatform, WindowingSession, boolean, typeof both][] = [
    // Windows and macOS: docking holds while the bounds asked are the bounds applied.
    ['win32', null, true, both],
    ['win32', null, false, unplacedOnly],
    ['darwin', null, true, both],
    ['darwin', null, false, unplacedOnly],
    // Linux on X11, or on Wayland started with --ozone-platform=x11 (XWayland, ADR-025 item 6): as on X11.
    ['linux', 'x11', true, both],
    ['linux', 'x11', false, unplacedOnly],
    ['linux', 'xwayland', true, both],
    ['linux', 'xwayland', false, unplacedOnly],
    // Native Wayland: the compositor places every window and Electron cannot set always-on-top (NFR-PLAT-05).
    ['linux', 'wayland', true, neither],
    ['linux', 'wayland', false, neither],
    // No graphical session the probe can name: fail closed.
    ['linux', 'none', true, neither],
    ['linux', 'none', false, neither]
  ]

  it('[NFR-PLAT-05, NFR-PLAT-04] the limits follow the platform, the session type and whether the bounds were applied', () => {
    for (const [platform, session, boundsApplied, expected] of rows) {
      expect(
        windowingLimits(platform, session, boundsApplied),
        `${platform} ${String(session)} ${String(boundsApplied)}`
      ).toEqual(expected)
    }
  })
})
