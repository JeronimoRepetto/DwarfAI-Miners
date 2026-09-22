import type { ConfigEnv } from '../config/config'

/**
 * Answering an OpenCode permission dialog over its own HTTP server, rather
 * than a console this app could ever type into (#588 T5).
 *
 * docs/opencode-format.md Row 15/16 measured the endpoint live, twice — once
 * against a server this investigation itself started, once against the
 * address a user's own interactive TUI bound: `POST
 * {serverUrl}session/{sessionID}/permissions/{permissionID}` with
 * `{"response":"once"|"always"|"reject"}` returns `200` and the JSON literal
 * `true`, and the blocked tool call then moves `running` -> `completed` on
 * the session's own store. `serverUrl` already ends with `/`
 * (permissionPushPayload.ts), so the path below is joined onto it with no
 * leading slash of its own.
 *
 * ## The one thing this file never proves
 *
 * HTTP Basic auth — `Authorization: Basic base64(username:password)`, from
 * `OPENCODE_SERVER_USERNAME` (default `opencode`) and
 * `OPENCODE_SERVER_PASSWORD` — is documented only by the strings inside the
 * compiled `opencode` binary and was NEVER exercised live: every server this
 * investigation measured (Row 15, Row 16) ran with no password set, so this
 * app has never sent this header against a real 401. Implemented anyway,
 * because a password an operator DOES set must not silently go
 * unauthenticated — and read off THIS process's own environment, which is
 * the only copy of those two names this app could ever have: the OpenCode
 * server that actually checks them runs in a DIFFERENT process, almost
 * always the person's own terminal, and nothing on this wire ever hands
 * either value across that boundary (permissionPushPayload.ts's
 * `OpenCodePermissionAskedPush` carries no credential of any kind). So this
 * only ever authenticates when the SAME two variables happen to be set in
 * the environment this app itself launched from — the same reading
 * `RuntimeOptions.simulationEnv`'s own comment (runtime.ts) gives a raw
 * environment read that belongs to nobody's settings screen, applied here to
 * a name this app does not own either. UNVERIFIED, stated loudly: nobody has
 * watched this header answer a real 401 yet.
 */

export type OpenCodePermissionAnswerFailureReason =
  'unreachable' | 'unauthorized' | 'timeout' | 'refused' | 'not-found'

/**
 * `answered: true` claims exactly what a typed keystroke claims on the
 * terminal channel and nothing more: OpenCode's own server accepted the
 * decision over HTTP. It says nothing about what the session then does with
 * it — that is the plugin's own later `permission.replied` push, read back
 * through `noteOpenCodePush` on its own timeline (Row 16: a successful
 * outside POST is followed by that very event).
 */
export type OpenCodePermissionAnswerOutcome =
  { answered: true } | { answered: false; reason: OpenCodePermissionAnswerFailureReason }

export interface OpenCodePermissionAnswerRequest {
  /** Already ends with '/' (permissionPushPayload.ts). */
  serverUrl: string
  sessionId: string
  requestId: string
  /**
   * OpenCode's own reply vocabulary, passed through verbatim. This app only
   * ever sends `'once'` or `'reject'` — see `answerOpenCodePermissionDialog`
   * (runtime.ts) for why `'always'` is never offered.
   */
  response: 'once' | 'always' | 'reject'
}

/** Injected so `AgentRuntime` can hand this to a decided prompt; the default below is the real POST. */
export type OpenCodePermissionAnswerPort = (
  request: OpenCodePermissionAnswerRequest
) => Promise<OpenCodePermissionAnswerOutcome>

/**
 * The narrow slice of the global `fetch`/`Response` surface this module
 * actually reads — mirrors `delegationLink.ts`'s own `DelegationFetch`, for
 * the identical reason: a hand-written fake in a test needs no more than
 * `status` and `json()` to stand in for a real `Response`, and the real
 * `globalThis.fetch` satisfies this structurally with no cast.
 */
export type OpenCodePermissionFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{
  status: number
  json(): Promise<unknown>
  /**
   * The narrow slice of `Response.body` this module reads — nothing but
   * `cancel()`, which is all F4 needs to release a non-200 connection
   * deterministically. Optional and possibly null, mirroring the real
   * `ReadableStream | null` fetch hands back, so a hand-written fake that
   * omits it (every 200-path fixture above) still satisfies this type.
   */
  body?: { cancel(): Promise<void> } | null
}>

/**
 * How long this app waits for OpenCode's own server to answer before giving
 * up (#588 T5) — generous next to the sub-second round trip Row 16 measured,
 * because what this bounds is how long a person is left looking at a card
 * that has not yet said anything, not the endpoint's own ordinary speed.
 */
export const OPENCODE_PERMISSION_POST_TIMEOUT_MS = 5_000

/**
 * Build the answer port over an injected fetch and environment, so a test can
 * pin every branch below without reaching a real network or a live CLI. The
 * shipped default (`postOpenCodePermissionDecision`) closes over the real
 * `fetch` and `process.env`.
 */
export function createOpenCodePermissionAnswerPort(
  fetchLike: OpenCodePermissionFetch,
  env: ConfigEnv
): OpenCodePermissionAnswerPort {
  return async (request) => {
    const url = new URL(
      `session/${encodeURIComponent(request.sessionId)}/permissions/${encodeURIComponent(request.requestId)}`,
      request.serverUrl
    ).href

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // See the module comment above: UNVERIFIED, sent only when a password is
    // actually configured — matching the server's own gate ("when no
    // password is set the server takes no auth", docs/opencode-format.md).
    const password = env.OPENCODE_SERVER_PASSWORD
    if (password !== undefined && password !== '') {
      const username = env.OPENCODE_SERVER_USERNAME ?? 'opencode'
      headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    }

    let response: Awaited<ReturnType<OpenCodePermissionFetch>>
    try {
      response = await fetchLike(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ response: request.response }),
        signal: AbortSignal.timeout(OPENCODE_PERMISSION_POST_TIMEOUT_MS)
      })
    } catch (error) {
      // AbortSignal.timeout's own abort reason is a DOMException named
      // 'TimeoutError', which fetch rejects with — standard, documented
      // behaviour, not a guess. Every OTHER throw here is the request never
      // reaching a server at all: refused, unresolved, reset — because the
      // process that owned this address (the TUI, or `opencode serve`) has
      // been closed (docs/opencode-format.md Row 15/16: the address is only
      // ever real while that process still owns it).
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      return { answered: false, reason: timedOut ? 'timeout' : 'unreachable' }
    }

    if (response.status !== 200) {
      // F4 (review finding): release the connection deterministically rather
      // than leave it checked out until GC — undici keeps a response's own
      // connection alive until its body is read or cancelled. Cancelling is
      // not reading: `json()` below stays untouched by every non-200 arm.
      await response.body?.cancel()
      if (response.status === 401) return { answered: false, reason: 'unauthorized' }
      // F3 (review finding): OpenCode's own PermissionNotFound. The prompt
      // this app is POSTing a decision to is already gone — answered at the
      // person's own terminal, or a second panel click — which is a
      // different fact from a decision the server declined. Named so
      // runtime.ts's openCodePermissionRefusal can say the honest sentence
      // (PROMPT_NO_LONGER_OPEN) instead of folding it into 'refused', whose
      // wording invites a re-click at a prompt that cannot be re-clicked.
      if (response.status === 404) return { answered: false, reason: 'not-found' }
      return { answered: false, reason: 'refused' }
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { answered: false, reason: 'refused' }
    }
    // Measured (Row 16): success is exactly `200` with the JSON literal
    // `true`. Anything else this app has never watched succeed — `false`, an
    // object, malformed JSON — is refused rather than trusted.
    return body === true ? { answered: true } : { answered: false, reason: 'refused' }
  }
}

/** The real port: the real network, the real environment (#588 T5). */
export const postOpenCodePermissionDecision: OpenCodePermissionAnswerPort =
  createOpenCodePermissionAnswerPort(globalThis.fetch, process.env)
