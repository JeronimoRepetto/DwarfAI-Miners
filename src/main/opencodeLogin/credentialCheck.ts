/**
 * Whether the OpenCode session about to launch has a credential for its
 * chosen model's provider (#597 T2) — read over the loopback control server
 * T1 starts, never over `auth.json`, which this app must never read (issue
 * #597's own constraint).
 *
 * ## Where the provider id comes from
 *
 * OpenCode model ids on this app's own wire are bare `provider/model`
 * strings (`src/main/providers/opencode/models.ts`'s own `ID_LINE`), never
 * validated further downstream than that regex, so `providerIdOf` mirrors
 * its shape rather than inventing a second one: the part before the FIRST
 * `/`, undefined for anything that does not carry a non-empty provider and a
 * non-empty model either side of it.
 *
 * ## The read
 *
 * `readConnectedProviders` is a narrow GET, on the same fetch-port shape
 * `answerOpenCodePermission.ts` already uses for its own POST — a
 * hand-written fake needs only `status` and `json()` to stand in for a real
 * `Response`, and the real `globalThis.fetch` satisfies it structurally.
 * Basic auth with the control server's own per-start password (T1) is
 * ALWAYS sent, unlike the permission answerer's optional Settings password:
 * this server is never started unsecured (see `buildControlServerSpawn`).
 *
 * Never rejects, and never throws past this file: every failure this can
 * observe is a typed `ok: false`. Failing here is failing OPEN — see
 * `launchCredentialGate.ts`, the caller that turns every reason this module
 * can report into "launch anyway".
 */

/** OpenCode's own default Basic username; the control server (T1) mints its own per-start password. */
const OPENCODE_SERVER_USERNAME = 'opencode'

/** Generous next to the sub-second `/provider` reads measured live (#597) — bounds a hung connection, not the ordinary case. */
export const OPENCODE_CREDENTIAL_CHECK_TIMEOUT_MS = 5_000

/**
 * The part of a bare `provider/model` id before the FIRST `/` — undefined
 * for anything `ID_LINE` would not recognise as one: no slash at all, an
 * empty provider ahead of it, or an empty model behind it.
 */
export function providerIdOf(model: string): string | undefined {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) return undefined
  return model.slice(0, slash)
}

/** The provider half's own character class, exactly as `ID_LINE` (providers/opencode/models.ts) allows it. */
const PROVIDER_ID_CHARS = /^[a-zA-Z0-9_.-]+$/

/**
 * Whether `value` could ever be a real OpenCode provider id (#597 T4
 * correction) — `ID_LINE`'s own character class, minus the two strings a URL
 * path resolves as navigation rather than a literal segment.
 *
 * `loginService.ts`'s three write routes each build a path by interpolating
 * a provider id after a fixed segment (`/auth/{id}`,
 * `/provider/{id}/oauth/...`). `encodeURIComponent` leaves `.` and `..`
 * unescaped, and `URL` resolves a dot segment before the request ever
 * leaves — so a provider id of exactly `.` or `..` sends the request (an API
 * key in its body, for `submitApiKey`) to the WRONG route instead of the one
 * this app asked for. Shared by `loginService.ts` and `index.ts`'s own IPC
 * boundary check, so both AGREE on what a provider id may even look like
 * rather than one trusting the other's refusal.
 */
export function isOpenCodeProviderIdShape(value: string): boolean {
  if (value === '.' || value === '..') return false
  return PROVIDER_ID_CHARS.test(value)
}

/**
 * The narrow slice of the global `fetch`/`Response` surface this module
 * reads — mirrors `answerOpenCodePermission.ts`'s own `OpenCodePermissionFetch`
 * for the identical reason: a hand-written fake needs no more than `status`
 * and `json()`, and the real `globalThis.fetch` satisfies this structurally
 * with no cast.
 */
export type OpenCodeConnectedFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }
) => Promise<{
  status: number
  json(): Promise<unknown>
  /** Released deterministically on every non-200 arm — see `OpenCodePermissionFetch.body`'s own comment. */
  body?: { cancel(): Promise<void> } | null
}>

export type ReadConnectedFailureReason = 'unreachable' | 'unauthorized' | 'timeout' | 'malformed'

export type ReadConnectedResult =
  { ok: true; connected: ReadonlySet<string> } | { ok: false; reason: ReadConnectedFailureReason }

/** `GET /provider`'s own measured shape (feature doc #597): only `connected` matters here. */
function connectedProvidersOf(body: unknown): ReadonlySet<string> | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const connected = (body as { connected?: unknown }).connected
  if (!Array.isArray(connected) || !connected.every((entry) => typeof entry === 'string')) {
    return undefined
  }
  return new Set(connected)
}

/**
 * `GET {serverUrl}/provider` with Basic auth, read for its `connected` list.
 * Never rejects: every way this can fail — the request never reaching a
 * server, a non-200 (401 above all), a body that is not the measured shape —
 * is a typed `ok: false` instead.
 */
export function readConnectedProviders(
  fetchLike: OpenCodeConnectedFetch,
  serverUrl: string,
  password: string
): Promise<ReadConnectedResult> {
  return (async (): Promise<ReadConnectedResult> => {
    // A leading slash resolves against `serverUrl` whether or not it carries
    // a trailing one — unlike a relative path, which the permission
    // answerer's own `serverUrl` (always slash-terminated, pushed by the
    // plugin) can rely on but this app-started server's announced URL does
    // not (`controlServer.ts`'s `ANNOUNCEMENT_PATTERN` captures no trailing
    // slash).
    const url = new URL('/provider', serverUrl).href
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`).toString('base64')}`
    }

    let response: Awaited<ReturnType<OpenCodeConnectedFetch>>
    try {
      response = await fetchLike(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(OPENCODE_CREDENTIAL_CHECK_TIMEOUT_MS)
      })
    } catch (error) {
      // AbortSignal.timeout's own abort reason is a DOMException named
      // 'TimeoutError' — standard, documented behaviour. Every other throw
      // here is the request never reaching a server at all.
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      return { ok: false, reason: timedOut ? 'timeout' : 'unreachable' }
    }

    if (response.status !== 200) {
      // Release the connection deterministically rather than leave it
      // checked out until GC — undici keeps a response's own connection
      // alive until its body is read or cancelled (F4, answerOpenCodePermission.ts).
      await response.body?.cancel()
      return { ok: false, reason: response.status === 401 ? 'unauthorized' : 'unreachable' }
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    const connected = connectedProvidersOf(body)
    return connected === undefined ? { ok: false, reason: 'malformed' } : { ok: true, connected }
  })()
}

/** Whether a launch may proceed, or which provider it is missing a credential for. */
export type OpenCodeCredentialDecision =
  { kind: 'ready' } | { kind: 'credential-missing'; providerId: string; model: string }

/**
 * Pure decision: given the chosen model and what `readConnectedProviders`
 * answered, may the launch proceed?
 *
 * No model chosen, or a model id this app cannot even read a provider out
 * of, is `'ready'` — nothing to check, the same reading `buildOpenCodeLaunch-
 * Args` gives an absent model (the CLI's own default). This is also what
 * keeps a free `opencode/*` model silent (issue #597's own acceptance
 * criterion): its provider id is `'opencode'`, and T1 measured that the free
 * provider is ALWAYS in `connected`, so this returns `'ready'` for it
 * without a special case naming the free tier at all.
 */
export function decideOpenCodeCredential(
  model: string | undefined,
  connected: ReadonlySet<string>
): OpenCodeCredentialDecision {
  if (model === undefined) return { kind: 'ready' }
  const providerId = providerIdOf(model)
  if (providerId === undefined) return { kind: 'ready' }
  if (connected.has(providerId)) return { kind: 'ready' }
  return { kind: 'credential-missing', providerId, model }
}
