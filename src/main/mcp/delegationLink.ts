import {
  DELEGATE_ROUTE,
  DELEGATION_TOKEN_HEADER,
  type DelegateRequestBody,
  type DelegationFailure,
  type DelegationRouting,
  type DelegationToolResult,
  delegationFailure,
  parseDelegateAcceptedBody,
  parseDelegateRefusedBody,
  parseResultBody,
  resultRoute
} from './delegationProtocol'

/**
 * How often `delegate`'s own poll loop calls `GET /result/<ticket>` while
 * waiting for the child to conclude (feature document, T2 decisions) —
 * exported so tests can assert cadence without hard-coding the literal in
 * two places.
 */
export const DELEGATION_POLL_INTERVAL_MS = 1_000

/**
 * The narrow slice of the global `fetch`/`Response` surface this module
 * actually reads — never the full DOM types, so a hand-written fake in a
 * test needs no more than `status` and `json()` to stand in for a real
 * `Response`. The real `globalThis.fetch` satisfies this structurally with
 * no cast (jevMcpServer.ts's own entry point passes it directly).
 */
export type DelegationFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }
) => Promise<{ status: number; json(): Promise<unknown> }>

export interface DelegationLinkOptions {
  /** `http://127.0.0.1:<port>` — validated already by `readLinkEnv`. */
  endpoint: string
  token: string
  fetch: DelegationFetch
  /** Wall-clock reading, injected so the poll deadline is provable with no real timers. */
  now: () => number
  /** Injected so a test drives every poll tick deterministically. */
  sleep: (ms: number) => Promise<void>
}

export interface DelegationLink {
  /**
   * `POST /delegate`, then poll `GET /result/<ticket>` every
   * `DELEGATION_POLL_INTERVAL_MS` until the child concludes, fails, or
   * `waitMs` elapses — in which case this resolves `pending` with the
   * ticket and routing rather than blocking the caller forever.
   */
  delegate(
    task: string,
    context: string | undefined,
    options: { waitMs: number }
  ): Promise<DelegationToolResult>
  /** One `GET /result/<ticket>` lookup, for `subtask_result`. */
  result(ticket: string): Promise<DelegationToolResult>
}

function requestHeaders(token: string): Record<string, string> {
  return { [DELEGATION_TOKEN_HEADER]: token, 'Content-Type': 'application/json' }
}

type RequestOutcome =
  { ok: true; status: number; json: unknown } | { ok: false; failure: DelegationFailure }

/**
 * Every network call this link makes goes through here, so the three ways a
 * loopback request can go wrong — unreachable, refused, unparsable — are
 * handled exactly once rather than once per route. Never throws: a link
 * that threw would push every caller back into try/catch, which is the
 * uniform-failure discipline `delegationFailure` itself exists to avoid.
 */
async function request(
  fetchImpl: DelegationFetch,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }
): Promise<RequestOutcome> {
  let response: { status: number; json(): Promise<unknown> }
  try {
    response = await fetchImpl(url, init)
  } catch {
    return {
      ok: false,
      failure: delegationFailure(
        'link-unreachable',
        'Could not reach the loopback delegation listener.'
      )
    }
  }
  // Rejected before any body is even read — the same discipline HookServer
  // holds for a bad token (hookServer.ts's own `handle`). Never echo the
  // token itself in the failure text; this app only ever says it was refused.
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      failure: delegationFailure(
        'link-unreachable',
        'The delegation listener refused this request’s token.'
      )
    }
  }
  let json: unknown
  try {
    json = await response.json()
  } catch {
    return {
      ok: false,
      failure: delegationFailure(
        'invalid-response',
        'The delegation listener answered with a body this app could not parse as JSON.'
      )
    }
  }
  return { ok: true, status: response.status, json }
}

/**
 * Build the loopback client one launched session's MCP server process talks
 * through (#511). Pure aside from the injected `fetch`/`now`/`sleep` seams —
 * no real network, no real timers, so `delegationLink.test.ts` proves every
 * behaviour with hand-written fakes only.
 */
export function createDelegationLink(options: DelegationLinkOptions): DelegationLink {
  const { endpoint, token, fetch: fetchImpl, now, sleep } = options

  async function result(ticket: string): Promise<DelegationToolResult> {
    const outcome = await request(fetchImpl, `${endpoint}${resultRoute(ticket)}`, {
      method: 'GET',
      headers: requestHeaders(token)
    })
    if (!outcome.ok) return { status: 'failed', failure: outcome.failure }
    const parsed = parseResultBody(outcome.json)
    if (parsed === undefined) {
      return {
        status: 'failed',
        failure: delegationFailure(
          'invalid-response',
          'The delegation listener answered /result with a body this app could not read.'
        )
      }
    }
    if (parsed.status === 'pending') {
      return { status: 'pending', ticket, routing: parsed.routing }
    }
    return parsed
  }

  async function pollUntil(
    ticket: string,
    routing: DelegationRouting,
    waitMs: number
  ): Promise<DelegationToolResult> {
    const deadline = now() + waitMs
    while (now() < deadline) {
      await sleep(DELEGATION_POLL_INTERVAL_MS)
      const polled = await result(ticket)
      if (polled.status !== 'pending') return polled
    }
    return { status: 'pending', ticket, routing }
  }

  async function delegate(
    task: string,
    context: string | undefined,
    delegateOptions: { waitMs: number }
  ): Promise<DelegationToolResult> {
    const body: DelegateRequestBody = { task, ...(context === undefined ? {} : { context }) }
    const outcome = await request(fetchImpl, `${endpoint}${DELEGATE_ROUTE}`, {
      method: 'POST',
      headers: requestHeaders(token),
      body: JSON.stringify(body)
    })
    if (!outcome.ok) return { status: 'failed', failure: outcome.failure }
    if (outcome.status === 202) {
      const accepted = parseDelegateAcceptedBody(outcome.json)
      if (accepted === undefined) {
        return {
          status: 'failed',
          failure: delegationFailure(
            'invalid-response',
            'The delegation listener accepted this request with a body this app could not read.'
          )
        }
      }
      return pollUntil(accepted.ticket, accepted.routing, delegateOptions.waitMs)
    }
    const refused = parseDelegateRefusedBody(outcome.json)
    if (refused === undefined) {
      return {
        status: 'failed',
        failure: delegationFailure(
          'invalid-response',
          'The delegation listener refused this request with a body this app could not read.'
        )
      }
    }
    return { status: 'failed', failure: refused.failure }
  }

  return { delegate, result }
}
