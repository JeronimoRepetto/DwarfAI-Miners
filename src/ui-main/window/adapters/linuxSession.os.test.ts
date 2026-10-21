// layer: L8
import { describe, expect, it } from 'vitest'
import { probeLinuxSession } from './linuxSession'

/**
 * The Linux session probe against the real environment of a Linux machine (17 §1.8, §1.13). The probe reads only the
 * variables the session exports, so what it answers here is what UI main reads at its start. The OS lane's Linux job
 * has no graphical session (preload.os.test.ts), where the probe answers `none`; a desktop answers the session it runs.
 * The release checklist records X11, XWayland and native Wayland on real machines (17 §1.13; S-025-3).
 */
describe.runIf(process.platform === 'linux')('the Linux session probe on Linux (L8)', () => {
  it('[NFR-PLAT-05] the session probe reports x11, xwayland or native wayland', () => {
    const env = process.env
    const has = (name: string): boolean => (env[name] ?? '') !== ''
    const expected = has('DISPLAY')
      ? env.XDG_SESSION_TYPE === 'wayland' || has('WAYLAND_DISPLAY')
        ? 'xwayland'
        : 'x11'
      : has('WAYLAND_DISPLAY')
        ? 'wayland'
        : 'none'
    expect(probeLinuxSession(env)).toBe(expected)
  })
})
