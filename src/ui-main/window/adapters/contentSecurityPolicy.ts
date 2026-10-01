/**
 * The content security policy of every window (ADR-019 item 4; 18 C-03). The renderer's own `index.html` declares it
 * in a `<meta>` tag, which is what a packaged build (loaded from `file://`) enforces; Electron main also sets it as
 * the response header of every page a window loads from a server (the dev server in development), so a page served
 * without that tag is held to the same policy. `connect-src` is `'self'` only: a renderer never talks to the network
 * or to the Host directly.
 *
 * Development only: the Vite HMR websocket origin joins `connect-src` when the composition root hands one in, which it
 * does only for an unpackaged app on a dev server. A packaged `index.html` never carries it (the release-lane check
 * `e2e/window/packagedCsp.e2e.ts`).
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'"

/** Electron's `session.webRequest.onHeadersReceived` listener, reduced to what the policy reads and answers. */
export type HeadersReceivedListener = (
  details: { responseHeaders?: Record<string, string[]> },
  callback: (response: { responseHeaders?: Record<string, string[]> }) => void
) => void

/** The policy, with the dev HMR websocket origin in `connect-src` when one is given. */
export function contentSecurityPolicy(devHmrOrigin?: string): string {
  if (devHmrOrigin === undefined) return CONTENT_SECURITY_POLICY
  return CONTENT_SECURITY_POLICY.replace("connect-src 'self'", `connect-src 'self' ${devHmrOrigin}`)
}

/** The websocket origin of a dev server (`http://localhost:5173` → `ws://localhost:5173`); none for anything else. */
export function devHmrOriginOf(devServerUrl: string | undefined): string | undefined {
  if (devServerUrl === undefined || !URL.canParse(devServerUrl)) return undefined
  const { protocol, host } = new URL(devServerUrl)
  if (protocol === 'http:') return `ws://${host}`
  if (protocol === 'https:') return `wss://${host}`
  return undefined
}

/**
 * Sets `policy` as the one `Content-Security-Policy` header of every response of `session` (the default session every
 * window uses): a CSP header the response already had, in any letter case, is replaced, never merged.
 */
export function applyContentSecurityPolicy(
  session: { webRequest: { onHeadersReceived(listener: HeadersReceivedListener): void } },
  policy: string
): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string[]> = {}
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (name.toLowerCase() !== 'content-security-policy') headers[name] = value
    }
    headers['Content-Security-Policy'] = [policy]
    callback({ responseHeaders: headers })
  })
}
