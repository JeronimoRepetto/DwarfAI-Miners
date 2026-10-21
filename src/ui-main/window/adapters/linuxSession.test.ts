// layer: L2
import { describe, expect, it } from 'vitest'
import {
  ozonePlatformFor,
  ozoneRelaunchArgs,
  probeLinuxSession,
  runningLinuxSession
} from './linuxSession'

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

  it('[NFR-PLAT-05] a start on a Wayland session with XWayland is relaunched once with --ozone-platform=x11', () => {
    // Electron picks its display backend before the main script runs, so the switch must be on the command line
    // (Electron docs, command-line switches, --ozone-platform): a start without it relaunches itself with it.
    const xwayland = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' }
    expect(ozoneRelaunchArgs('linux', xwayland, ['--background'])).toEqual([
      '--background',
      '--ozone-platform=x11'
    ])
    // Already on the command line (a relaunch, a launcher script, a .desktop file): never a second relaunch.
    expect(ozoneRelaunchArgs('linux', xwayland, ['--ozone-platform=x11'])).toBeNull()
    expect(ozoneRelaunchArgs('linux', xwayland, ['--ozone-platform=wayland'])).toBeNull()
    // Plain X11, native Wayland, Windows and macOS start as they are.
    expect(ozoneRelaunchArgs('linux', { DISPLAY: ':0' }, [])).toBeNull()
    expect(ozoneRelaunchArgs('linux', { WAYLAND_DISPLAY: 'wayland-0' }, [])).toBeNull()
    expect(ozoneRelaunchArgs('win32', xwayland, [])).toBeNull()
    expect(ozoneRelaunchArgs('darwin', xwayland, [])).toBeNull()
  })

  it('[NFR-PLAT-05] the session the app runs in counts the backend its command line chose', () => {
    const xwayland = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' }
    expect(runningLinuxSession(xwayland, ['--ozone-platform=x11'])).toBe('xwayland')
    // No switch on a Wayland session: Electron runs as a native Wayland client.
    expect(runningLinuxSession(xwayland, [])).toBe('wayland')
    expect(runningLinuxSession(xwayland, ['--ozone-platform=wayland'])).toBe('wayland')
    expect(runningLinuxSession({ DISPLAY: ':0' }, [])).toBe('x11')
    expect(runningLinuxSession({ WAYLAND_DISPLAY: 'wayland-0' }, [])).toBe('wayland')
    expect(runningLinuxSession({}, [])).toBe('none')
  })
})
