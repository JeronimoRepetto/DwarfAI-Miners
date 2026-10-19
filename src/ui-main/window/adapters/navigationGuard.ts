import { externalLinkOf } from '@dwarfai/contracts'

/**
 * The app-wide navigation guard (ADR-019 item 2; 18 C-02). Every `webContents` Electron creates is kept on the app's
 * own entry: a navigation or a redirect anywhere else is prevented, a webview is never attached, and a page that asks
 * for a new window never gets one. A link it asks for opens in the system browser only when `externalLinkOf` (the same
 * http/https, at most 2048 characters allowlist that guards the `openExternalLink` channel, 14 A-21) admits it.
 */

/** The part of Electron's `will-navigate` / `will-redirect` event the guard reads. */
export interface NavigationEvent {
  readonly url: string
  preventDefault(): void
}

/** The part of Electron's `WebContents` the guard attaches to. */
export interface GuardableWebContents {
  on(event: 'will-navigate' | 'will-redirect', listener: (event: NavigationEvent) => void): unknown
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
}

export interface NavigationGuardDeps {
  /** The app's own entry: the packaged `index.html` file URL, or the dev-server URL in development. */
  readonly appEntry: string
  /** Hands an allowlisted link to the system browser (Electron's `shell.openExternal`). */
  openExternal(url: string): void
}

/**
 * Whether `url` is the app's own entry. A `file:` entry is one document: the same path, whatever its query or
 * fragment. An http(s) entry is the dev server, so any page of its origin (scheme, host and port) counts. A string
 * that is not an absolute URL is never the entry.
 */
export function isAppEntry(appEntry: string, url: string): boolean {
  if (!URL.canParse(appEntry) || !URL.canParse(url)) return false
  const entry = new URL(appEntry)
  const target = new URL(url)
  if (entry.protocol === 'http:' || entry.protocol === 'https:')
    return target.origin === entry.origin
  return (
    target.protocol === entry.protocol &&
    target.host === entry.host &&
    target.pathname === entry.pathname
  )
}

/** Attaches the guard to one `webContents`. */
export function guardWebContents(contents: GuardableWebContents, deps: NavigationGuardDeps): void {
  const keepOnEntry = (event: NavigationEvent): void => {
    if (!isAppEntry(deps.appEntry, event.url)) event.preventDefault()
  }
  contents.on('will-navigate', keepOnEntry)
  contents.on('will-redirect', keepOnEntry)
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    const safe = externalLinkOf(url)
    if (safe !== null) deps.openExternal(safe)
    return { action: 'deny' }
  })
}

/** Guards every `webContents` the app creates, from the first one (`app.on('web-contents-created')`). */
export function installNavigationGuard(
  app: {
    on(
      event: 'web-contents-created',
      listener: (event: unknown, contents: GuardableWebContents) => void
    ): unknown
  },
  deps: NavigationGuardDeps
): void {
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents, deps))
}
