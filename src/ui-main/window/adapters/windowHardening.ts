import {
  applyContentSecurityPolicy,
  contentSecurityPolicy,
  type HeadersReceivedListener
} from './contentSecurityPolicy'
import { installNavigationGuard, type GuardableWebContents } from './navigationGuard'
import { denyEveryPermission, type PermissionSession } from './permissionDenial'

/**
 * The app-wide window hardening of ADR-019 items 2–4, installed once by the Electron composition root before any
 * window exists: the navigation guard on every `webContents` from the first one, then, once Electron is ready (the
 * default session exists only then), the permission denial and the CSP response header on the default session every
 * window uses. The window factory (ADR-019 item 1) is `secureWindowOptions`; this is everything that is not per window.
 */

/** The parts of Electron's default `Session` the hardening installs into. */
export interface HardeningSession extends PermissionSession {
  webRequest: { onHeadersReceived(listener: HeadersReceivedListener): void }
}

export interface WindowHardeningDeps {
  /** Electron's `app`: `web-contents-created` and `whenReady`. */
  app: {
    on(
      event: 'web-contents-created',
      listener: (event: unknown, contents: GuardableWebContents) => void
    ): unknown
    whenReady(): Promise<unknown>
  }
  /** Electron's `session.defaultSession`, read once Electron is ready. */
  session(): HardeningSession
  /** Electron's `shell.openExternal`, for the allowlisted links the guard lets out. */
  openExternal(url: string): void
  /** The app's own entry (ADR-019 item 2). */
  appEntry: string
  /** The dev HMR websocket origin, handed in only for an unpackaged app on a dev server (ADR-019 item 4). */
  devHmrOrigin?: string
}

export function installWindowHardening(deps: WindowHardeningDeps): void {
  installNavigationGuard(deps.app, { appEntry: deps.appEntry, openExternal: deps.openExternal })
  void deps.app.whenReady().then(() => {
    const session = deps.session()
    denyEveryPermission(session)
    applyContentSecurityPolicy(session, contentSecurityPolicy(deps.devHmrOrigin))
  })
}
