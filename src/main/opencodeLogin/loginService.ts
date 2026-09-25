import type {
  OpenCodeAuthMethod,
  OpenCodeAuthMethodsResult,
  OpenCodeAuthPrompt,
  OpenCodeAuthPromptWhen,
  OpenCodeAuthSelectOption,
  OpenCodeLoginFailureReason,
  OpenCodeLoginResult,
  OpenCodeOAuthStartResult
} from '../domain/types'
import type { OpenCodeControlServerPort } from './controlServer'
import { readConnectedProviders, type OpenCodeConnectedFetch } from './credentialCheck'

/**
 * Completing an OpenCode login without a terminal (#597 T4) — the four
 * routes T3's own credential gate leaves for a dialog: listing a provider's
 * methods, submitting an API key, and both OAuth steps. Composes T1's
 * control server exactly as `launchCredentialGate.ts` does, over an injected
 * fetch so nothing here ever reaches a real network in a test.
 *
 * Never rejects: every failure this can observe — the control server would
 * not start, the request never reached it, a non-200, a body this app does
 * not recognise — is a typed `ok: false` result, on the same discipline
 * `credentialCheck.ts` and `answerOpenCodePermission.ts` already hold.
 *
 * ## Secrets
 *
 * An API key and a pasted OAuth code cross renderer -> preload -> main
 * exactly once and go straight into the request body below. Neither is ever
 * logged, stored on this side of that one hop, or echoed back — every result
 * type here carries only a boolean and a closed set of failure reasons, never
 * a free-text detail a caller could accidentally build out of the request.
 */

/** OpenCode's own default Basic username; mirrors `credentialCheck.ts`'s identical constant (T2). */
const OPENCODE_SERVER_USERNAME = 'opencode'

/** Generous next to an ordinary round trip — bounds a hung connection, not the ordinary case. */
export const OPENCODE_LOGIN_REQUEST_TIMEOUT_MS = 5_000

/**
 * How long `completeOAuth` waits for an `'auto'` method before giving up.
 * OpenCode's own server blocks this call until the person finishes in their
 * browser (a device-code flow), so this bounds a whole human trip there and
 * back rather than an ordinary HTTP round trip — generous on purpose.
 */
export const OPENCODE_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000

/**
 * The narrow slice of the global `fetch`/`Response` surface this module
 * reads — one shape for all three verbs this service uses, unlike
 * `credentialCheck.ts`'s GET-only `OpenCodeConnectedFetch`, because a login
 * operation is a PUT or a POST as often as a GET. A hand-written fake needs
 * no more than `status` and `json()`, and the real `globalThis.fetch`
 * satisfies this structurally with no cast.
 */
export type OpenCodeLoginFetch = (
  url: string,
  init: {
    method: 'GET' | 'PUT' | 'POST'
    headers: Record<string, string>
    body?: string
    signal: AbortSignal
  }
) => Promise<{
  status: number
  json(): Promise<unknown>
  /** Released deterministically on every non-200 arm — see `readConnectedProviders`'s own comment. */
  body?: { cancel(): Promise<void> } | null
}>

export interface OpenCodeLoginServiceOptions {
  /** Only `ensure()` is read — never `stop()`, which belongs to app shutdown alone (see launchCredentialGate.ts). */
  controlServer: Pick<OpenCodeControlServerPort, 'ensure'>
  fetch: OpenCodeLoginFetch
  requestTimeoutMs?: number
  completeOAuthTimeoutMs?: number
}

export interface OpenCodeLoginServicePort {
  /** `GET /provider/auth`, filtered to one provider. */
  listAuthMethods(providerId: string): Promise<OpenCodeAuthMethodsResult>
  /** `PUT /auth/{id}` with an API key, then a re-read of `connected`. */
  submitApiKey(providerId: string, key: string): Promise<OpenCodeLoginResult>
  /** `POST /provider/{id}/oauth/authorize`. */
  startOAuth(
    providerId: string,
    method: number,
    inputs?: Record<string, string>
  ): Promise<OpenCodeOAuthStartResult>
  /** `POST /provider/{id}/oauth/callback`, then a re-read of `connected`. Bounded; see `cancelOAuth`. */
  completeOAuth(providerId: string, method: number, code?: string): Promise<OpenCodeLoginResult>
  /**
   * Abort whichever `completeOAuth` call is in flight, if any — otherwise a
   * no-op. Only one login dialog is ever open at a time, so there is nothing
   * to name: this cancels THE current completion, not a specific one.
   */
  cancelOAuth(): void
}

function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`).toString('base64')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `ProviderAuthMethod.prompts[].when`'s own shape (measured #597 T4) — validated fully since it decides what a dialog even shows. */
function parseAuthPromptWhen(value: unknown): OpenCodeAuthPromptWhen | undefined {
  if (!isRecord(value)) return undefined
  const { key, op, value: matchValue } = value
  if (typeof key !== 'string' || typeof matchValue !== 'string') return undefined
  if (op !== 'eq' && op !== 'neq') return undefined
  return { key, op, value: matchValue }
}

function parseAuthSelectOption(value: unknown): OpenCodeAuthSelectOption | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.label !== 'string' || typeof value.value !== 'string') return undefined
  return {
    label: value.label,
    value: value.value,
    ...(typeof value.hint === 'string' ? { hint: value.hint } : {})
  }
}

function parseAuthPrompt(value: unknown): OpenCodeAuthPrompt | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.key !== 'string' || typeof value.message !== 'string') return undefined
  // Present-but-unreadable is refused rather than dropped: a `when` clause
  // this app cannot honour would show a field the person cannot actually
  // reach, or hide one they need.
  let when: OpenCodeAuthPromptWhen | undefined
  if (value.when !== undefined) {
    const parsed = parseAuthPromptWhen(value.when)
    if (parsed === undefined) return undefined
    when = parsed
  }

  if (value.type === 'text') {
    return {
      type: 'text',
      key: value.key,
      message: value.message,
      ...(typeof value.placeholder === 'string' ? { placeholder: value.placeholder } : {}),
      ...(when === undefined ? {} : { when })
    }
  }
  if (value.type === 'select') {
    if (!Array.isArray(value.options)) return undefined
    const options: OpenCodeAuthSelectOption[] = []
    for (const raw of value.options) {
      const option = parseAuthSelectOption(raw)
      if (option === undefined) return undefined
      options.push(option)
    }
    return {
      type: 'select',
      key: value.key,
      message: value.message,
      options,
      ...(when === undefined ? {} : { when })
    }
  }
  return undefined
}

function parseAuthMethod(value: unknown): OpenCodeAuthMethod | undefined {
  if (!isRecord(value)) return undefined
  if (value.type !== 'oauth' && value.type !== 'api') return undefined
  if (typeof value.label !== 'string') return undefined
  if (value.prompts === undefined) return { type: value.type, label: value.label }
  if (!Array.isArray(value.prompts)) return undefined
  const prompts: OpenCodeAuthPrompt[] = []
  for (const raw of value.prompts) {
    const prompt = parseAuthPrompt(raw)
    if (prompt === undefined) return undefined
    prompts.push(prompt)
  }
  return { type: value.type, label: value.label, prompts }
}

type EnsuredServer = { url: string; password: string }
type EnsureFailure = { ok: false; reason: 'server-unavailable' }

export function createOpenCodeLoginService(
  options: OpenCodeLoginServiceOptions
): OpenCodeLoginServicePort {
  const requestTimeoutMs = options.requestTimeoutMs ?? OPENCODE_LOGIN_REQUEST_TIMEOUT_MS
  const oauthCallbackTimeoutMs =
    options.completeOAuthTimeoutMs ?? OPENCODE_OAUTH_CALLBACK_TIMEOUT_MS
  /** The current `completeOAuth`'s own abort, or null while none is in flight. */
  let cancelCurrentOAuth: (() => void) | null = null

  async function ensureServer(): Promise<({ ok: true } & EnsuredServer) | EnsureFailure> {
    const server = await options.controlServer.ensure()
    if (!server.ok) return { ok: false, reason: 'server-unavailable' }
    return { ok: true, url: server.url, password: server.readPassword() }
  }

  /** Maps a caught fetch error to the two reasons this app can tell apart without a status code. */
  function unreachableOrTimeout(error: unknown): { ok: false; reason: OpenCodeLoginFailureReason } {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    return { ok: false, reason: timedOut ? 'timeout' : 'unreachable' }
  }

  /** Maps a non-200 status the same way on every route: 401 is ours to tell apart, everything else OpenCode itself refused. */
  async function refusalFor(response: {
    status: number
    body?: { cancel(): Promise<void> } | null
  }): Promise<{ ok: false; reason: OpenCodeLoginFailureReason }> {
    await response.body?.cancel()
    return { ok: false, reason: response.status === 401 ? 'unauthorized' : 'refused' }
  }

  /**
   * `GET /provider`'s own `connected` set, read again right after a write
   * succeeds — reusing T2's `readConnectedProviders` rather than a second
   * copy of that parsing. A read that itself fails reports `false`: the
   * WRITE already succeeded (its own 200/true was checked before this is
   * ever called), so a flaky re-read must not turn a real success into a
   * failure — it costs the dialog one extra manual retry of the check,
   * never a login that silently did not stick.
   */
  async function isNowConnected(server: EnsuredServer, providerId: string): Promise<boolean> {
    const getFetch: OpenCodeConnectedFetch = (url, init) => options.fetch(url, init)
    const read = await readConnectedProviders(getFetch, server.url, server.password)
    return read.ok && read.connected.has(providerId)
  }

  async function listAuthMethods(providerId: string): Promise<OpenCodeAuthMethodsResult> {
    const server = await ensureServer()
    if (!server.ok) return server
    const url = new URL('/provider/auth', server.url).href

    let response: Awaited<ReturnType<OpenCodeLoginFetch>>
    try {
      response = await options.fetch(url, {
        method: 'GET',
        headers: { authorization: basicAuthHeader(server.password) },
        signal: AbortSignal.timeout(requestTimeoutMs)
      })
    } catch (error) {
      return unreachableOrTimeout(error)
    }
    if (response.status !== 200) return refusalFor(response)

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (!isRecord(body)) return { ok: false, reason: 'malformed' }
    // Absent means this provider has nothing to show, not a broken answer
    // (issue #597's own acceptance: a provider this dialog was never opened
    // for is simply not among the keys `GET /provider/auth` returns).
    const raw = body[providerId]
    if (raw === undefined) return { ok: true, methods: [] }
    if (!Array.isArray(raw)) return { ok: false, reason: 'malformed' }
    const methods: OpenCodeAuthMethod[] = []
    for (const entry of raw) {
      const method = parseAuthMethod(entry)
      if (method === undefined) return { ok: false, reason: 'malformed' }
      methods.push(method)
    }
    return { ok: true, methods }
  }

  async function submitApiKey(providerId: string, key: string): Promise<OpenCodeLoginResult> {
    const server = await ensureServer()
    if (!server.ok) return server
    const url = new URL(`/auth/${encodeURIComponent(providerId)}`, server.url).href

    let response: Awaited<ReturnType<OpenCodeLoginFetch>>
    try {
      response = await options.fetch(url, {
        method: 'PUT',
        headers: {
          authorization: basicAuthHeader(server.password),
          'content-type': 'application/json'
        },
        // The one place `key` is ever read: straight into the body, never
        // logged and never carried into a returned value on any path below.
        body: JSON.stringify({ type: 'api', key }),
        signal: AbortSignal.timeout(requestTimeoutMs)
      })
    } catch (error) {
      return unreachableOrTimeout(error)
    }
    if (response.status !== 200) return refusalFor(response)

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    // Measured: success is exactly the JSON literal `true` — the same
    // discipline `answerOpenCodePermission.ts` holds for its own boolean.
    if (body !== true) return { ok: false, reason: 'malformed' }
    return { ok: true, connected: await isNowConnected(server, providerId) }
  }

  async function startOAuth(
    providerId: string,
    method: number,
    inputs?: Record<string, string>
  ): Promise<OpenCodeOAuthStartResult> {
    const server = await ensureServer()
    if (!server.ok) return server
    const url = new URL(`/provider/${encodeURIComponent(providerId)}/oauth/authorize`, server.url)
      .href

    let response: Awaited<ReturnType<OpenCodeLoginFetch>>
    try {
      response = await options.fetch(url, {
        method: 'POST',
        headers: {
          authorization: basicAuthHeader(server.password),
          'content-type': 'application/json'
        },
        body: JSON.stringify(inputs === undefined ? { method } : { method, inputs }),
        signal: AbortSignal.timeout(requestTimeoutMs)
      })
    } catch (error) {
      return unreachableOrTimeout(error)
    }
    if (response.status !== 200) return refusalFor(response)

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (
      !isRecord(body) ||
      typeof body.url !== 'string' ||
      typeof body.instructions !== 'string' ||
      (body.method !== 'auto' && body.method !== 'code')
    ) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, url: body.url, method: body.method, instructions: body.instructions }
  }

  async function completeOAuth(
    providerId: string,
    method: number,
    code?: string
  ): Promise<OpenCodeLoginResult> {
    const server = await ensureServer()
    if (!server.ok) return server
    const url = new URL(`/provider/${encodeURIComponent(providerId)}/oauth/callback`, server.url)
      .href

    // A device-code ('auto') method blocks this call inside OpenCode's own
    // server until the person finishes in their browser, so this needs its
    // OWN abort rather than the fixed per-request timeout every other route
    // here uses — one bound for the whole human wait, and a second way to
    // end it early: the person cancelling the dialog.
    let cancelled = false
    const controller = new AbortController()
    cancelCurrentOAuth = () => {
      cancelled = true
      controller.abort()
    }
    const timer = setTimeout(() => controller.abort(), oauthCallbackTimeoutMs)
    timer.unref?.()

    let response: Awaited<ReturnType<OpenCodeLoginFetch>>
    try {
      response = await options.fetch(url, {
        method: 'POST',
        headers: {
          authorization: basicAuthHeader(server.password),
          'content-type': 'application/json'
        },
        // The one place `code` is ever read: straight into the body, never
        // logged and never carried into a returned value on any path below.
        body: JSON.stringify(code === undefined ? { method } : { method, code }),
        signal: controller.signal
      })
    } catch {
      clearTimeout(timer)
      cancelCurrentOAuth = null
      // The two things that ever abort THIS controller are `cancelOAuth` and
      // the timer above; the flag set synchronously by `cancelOAuth` tells
      // them apart, and anything that leaves the signal un-aborted is an
      // ordinary connection failure, not either of those.
      if (cancelled) return { ok: false, reason: 'cancelled' }
      if (controller.signal.aborted) return { ok: false, reason: 'timeout' }
      return { ok: false, reason: 'unreachable' }
    }
    clearTimeout(timer)
    cancelCurrentOAuth = null

    if (response.status !== 200) return refusalFor(response)

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (body !== true) return { ok: false, reason: 'malformed' }
    return { ok: true, connected: await isNowConnected(server, providerId) }
  }

  function cancelOAuth(): void {
    cancelCurrentOAuth?.()
  }

  return { listAuthMethods, submitApiKey, startOAuth, completeOAuth, cancelOAuth }
}
