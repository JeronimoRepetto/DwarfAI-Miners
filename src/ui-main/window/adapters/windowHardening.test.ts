import { describe, expect, it } from 'vitest'
import { CONTENT_SECURITY_POLICY, type HeadersReceivedListener } from './contentSecurityPolicy'
import type { GuardableWebContents } from './navigationGuard'
import { installWindowHardening, type HardeningSession } from './windowHardening'

const APP_ENTRY = 'file:///opt/dwarfai/resources/app.asar/out/renderer/index.html'

function fakeElectron() {
  const steps: string[] = []
  let ready: () => void = () => undefined
  let created: ((event: unknown, contents: GuardableWebContents) => void) | null = null
  let headers: HeadersReceivedListener | null = null
  let checkHandler: ((...args: never[]) => boolean) | null = null
  const session: HardeningSession = {
    setPermissionRequestHandler: () => {
      steps.push('permission request handler')
    },
    setPermissionCheckHandler: (handler) => {
      steps.push('permission check handler')
      checkHandler = handler as (...args: never[]) => boolean
    },
    webRequest: {
      onHeadersReceived: (listener) => {
        steps.push('csp')
        headers = listener
      }
    }
  }
  const app = {
    on: (_event: 'web-contents-created', listener: typeof created) => {
      steps.push('guard')
      created = listener
    },
    whenReady: () =>
      new Promise<void>((resolve) => {
        ready = resolve
      })
  }
  const opened: string[] = []
  return {
    steps,
    app,
    session,
    opened,
    openExternal: (url: string) => opened.push(url),
    ready: async () => {
      ready()
      await Promise.resolve()
      await Promise.resolve()
    },
    created: () => created,
    headers: () => headers,
    check: () => checkHandler
  }
}

describe('window hardening (ADR-019 items 2–4)', () => {
  it('[ADR-019] the guard is installed at once and the permission denial and the CSP once Electron is ready', async () => {
    const electron = fakeElectron()
    installWindowHardening({
      app: electron.app,
      session: () => electron.session,
      openExternal: electron.openExternal,
      appEntry: APP_ENTRY
    })
    expect(electron.steps, 'before ready: only the guard').toEqual(['guard'])
    await electron.ready()
    expect(electron.steps).toEqual([
      'guard',
      'permission request handler',
      'permission check handler',
      'csp'
    ])
    expect(electron.check()?.()).toBe(false)
    let answered: Record<string, string[]> | undefined
    electron.headers()?.({ responseHeaders: {} }, (response) => {
      answered = response.responseHeaders
    })
    expect(answered).toEqual({ 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] })
  })

  it('[ADR-019] the dev HMR origin reaches the CSP only when one is handed in', async () => {
    const electron = fakeElectron()
    installWindowHardening({
      app: electron.app,
      session: () => electron.session,
      openExternal: electron.openExternal,
      appEntry: 'http://localhost:5173',
      devHmrOrigin: 'ws://localhost:5173'
    })
    await electron.ready()
    let answered: Record<string, string[]> | undefined
    electron.headers()?.({}, (response) => {
      answered = response.responseHeaders
    })
    expect(answered?.['Content-Security-Policy']?.[0] ?? 'no CSP header').toContain(
      "connect-src 'self' ws://localhost:5173"
    )
  })
})
