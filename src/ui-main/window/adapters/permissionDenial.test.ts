import { describe, expect, it } from 'vitest'
import { denyEveryPermission, type PermissionSession } from './permissionDenial'

/** Every permission name Electron 44's two session handlers can be asked for (electron.d.ts). */
const REQUESTED = [
  'clipboard-read',
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'geolocation',
  'idle-detection',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'pointerLock',
  'keyboardLock',
  'openExternal',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
  'window-management',
  'unknown',
  'fileSystem'
] as const
const CHECKED = [
  'clipboard-read',
  'clipboard-sanitized-write',
  'geolocation',
  'fullscreen',
  'hid',
  'idle-detection',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'openExternal',
  'pointerLock',
  'serial',
  'storage-access',
  'top-level-storage-access',
  'usb',
  'deprecated-sync-clipboard-read',
  'fileSystem'
] as const

/** A session stand-in that keeps the two handlers the app installs. */
function fakeSession() {
  const session: PermissionSession & {
    request: ((permission: string, callback: (granted: boolean) => void) => void) | null
    check: ((permission: string) => boolean) | null
  } = {
    request: null,
    check: null,
    setPermissionRequestHandler(handler) {
      session.request = handler === null ? null : (p, cb) => handler(null, p, cb, {})
    },
    setPermissionCheckHandler(handler) {
      session.check = handler === null ? null : (p) => handler(null, p, '', {})
    }
  }
  return session
}

describe('permission denial (ADR-019 item 3; 18 C-05)', () => {
  it('[ADR-019] every permission request and check is denied', () => {
    const session = fakeSession()
    denyEveryPermission(session)
    expect(session.request, 'request handler installed').not.toBeNull()
    expect(session.check, 'check handler installed').not.toBeNull()
    for (const permission of REQUESTED) {
      const answers: boolean[] = []
      session.request!(permission, (granted) => answers.push(granted))
      expect(answers, `request ${permission}`).toEqual([false])
    }
    for (const permission of CHECKED) {
      expect(session.check!(permission), `check ${permission}`).toBe(false)
    }
  })
})
