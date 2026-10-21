// layer: L2
import { describe, expect, it } from 'vitest'
import { ozonePlatformFor, probeLinuxSession } from './linuxSession'

describe('the Linux session probe (ADR-025 item 6; UC-068)', () => {
  it('[NFR-PLAT-05] the session type follows the display variables the session sets', () => {
    expect(probeLinuxSession({ DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' })).toBe('x11')
    expect(probeLinuxSession({ DISPLAY: ':0' })).toBe('x11')
    // A Wayland session with XWayland exports both: the app starts on X11 through XWayland.
    expect(
      probeLinuxSession({
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_SESSION_TYPE: 'wayland'
      })
    ).toBe('xwayland')
    expect(probeLinuxSession({ DISPLAY: ':1', XDG_SESSION_TYPE: 'wayland' })).toBe('xwayland')
    // Native Wayland: no X server to start on.
    expect(probeLinuxSession({ WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' })).toBe(
      'wayland'
    )
    // An empty variable is no display at all; nothing nameable fails closed.
    expect(probeLinuxSession({ DISPLAY: '', WAYLAND_DISPLAY: '' })).toBe('none')
    expect(probeLinuxSession({})).toBe('none')
  })

  it('[NFR-PLAT-05] the app asks for the X11 Ozone platform only where XWayland is available', () => {
    expect(ozonePlatformFor('xwayland')).toBe('x11')
    for (const session of ['x11', 'wayland', 'none'] as const) {
      expect(ozonePlatformFor(session), session).toBeNull()
    }
  })
})
