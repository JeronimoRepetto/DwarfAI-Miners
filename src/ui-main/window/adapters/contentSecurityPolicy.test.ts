import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTENT_SECURITY_POLICY,
  applyContentSecurityPolicy,
  contentSecurityPolicy,
  devHmrOriginOf,
  type HeadersReceivedListener
} from './contentSecurityPolicy'

/** A session stand-in that keeps the response-headers listener and runs one response through it. */
function fakeSession() {
  let listener: HeadersReceivedListener | null = null
  return {
    session: {
      webRequest: {
        onHeadersReceived: (l: HeadersReceivedListener) => {
          listener = l
        }
      }
    },
    respond(responseHeaders: Record<string, string[]> | undefined) {
      if (listener === null) throw new Error('no headers listener installed')
      let answered: Record<string, string[]> | undefined
      listener({ responseHeaders }, (response) => {
        answered = response.responseHeaders
      })
      return answered
    }
  }
}

describe('content security policy (ADR-019 item 4; 18 C-03)', () => {
  it('[ADR-019] every window response carries the CSP with connect-src self and no other CSP', () => {
    const { session, respond } = fakeSession()
    applyContentSecurityPolicy(session, contentSecurityPolicy())
    expect(
      respond({ 'content-type': ['text/html'], 'content-security-policy': ['default-src *'] })
    ).toEqual({
      'content-type': ['text/html'],
      'Content-Security-Policy': [CONTENT_SECURITY_POLICY]
    })
    expect(respond(undefined)).toEqual({ 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] })
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'")
    expect(CONTENT_SECURITY_POLICY).not.toContain('ws:')
  })

  it('[ADR-019] the dev HMR websocket origin joins connect-src only when one is injected', () => {
    expect(contentSecurityPolicy()).toBe(CONTENT_SECURITY_POLICY)
    expect(contentSecurityPolicy(undefined)).toBe(CONTENT_SECURITY_POLICY)
    expect(contentSecurityPolicy('ws://localhost:5173')).toBe(
      CONTENT_SECURITY_POLICY.replace(
        "connect-src 'self'",
        "connect-src 'self' ws://localhost:5173"
      )
    )
    expect(devHmrOriginOf('http://localhost:5173')).toBe('ws://localhost:5173')
    expect(devHmrOriginOf('https://127.0.0.1:5173/index.html')).toBe('wss://127.0.0.1:5173')
    expect(devHmrOriginOf(undefined)).toBeUndefined()
    expect(devHmrOriginOf('file:///app/index.html')).toBeUndefined()
    expect(devHmrOriginOf('not a url')).toBeUndefined()
  })

  it('[ADR-019] the renderer index.html declares the window CSP with connect-src self and no ws origin', () => {
    const html = readFileSync(join(import.meta.dirname, '../../../renderer/index.html'), 'utf8')
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)
    expect(meta?.[1]).toBe(CONTENT_SECURITY_POLICY)
  })
})
