// The Host's HTTP client of an `opencode serve` (15 §4.6 rows "Person-run server" and "Resume /
// identity"; ADR-017 item 3; 18 C-22; ISSUE-237): the one place the OpenCode server driver talks
// to a server, so the password rules hold for every call.
//
// - Only plain `http` on this machine's loopback (`127.0.0.1`, `localhost`, `[::1]`), with no
//   credentials, path, query or fragment in the address. Anything else is `unreachable`
//   `not-loopback` before the password is even read, so it never leaves the machine.
// - A person-run server (`owner: 'person'`): the stored password is read through the kernel
//   `SecretReader` for each call, outside any transaction, kept only for that call and placed only
//   in the `Authorization` header, as HTTP Basic with OpenCode's default user `opencode`
//   (opencode.ai/docs/server: "Set OPENCODE_SERVER_PASSWORD to protect the server with HTTP basic
//   auth. The username defaults to opencode"). Never in the URL, the body, any other header, a log
//   record, argv or an environment (ADR-017 item 3, 15 §6 C-23). Not configured: no header (an
//   unprotected server needs none; a protected one answers 401, below). A read that times out
//   (`'timeout'`, 16 §2.6) or fails is `unavailable` with nothing sent (FM-116).
// - The Host's own server (`owner: 'host'`): the person's password is never read for it and never
//   sent to it (21 §2 4b: "the Host's own servers do not use it"). No such server is started today
//   (S-031-3, `./capabilities` SERVER_PROTECTION).
// - One request per call, never retried: 401 is `unreachable` `unauthorized` (the stored password
//   is missing or rejected); another non-2xx, a failed connection or no answer within
//   OPENCODE_SERVER_CALL_TIMEOUT_MS is `unreachable` too. The person is never prompted for the
//   secret. Each failure is one `opencode-server.*` record with its cause class only (19 §7).
//
// Package gaps resolved here (recorded in the PR): the Basic scheme and the `opencode` user are
// OpenCode's documented server auth, not measured against a server by S-031-3 (which recorded the
// three status codes only); a person who set `OPENCODE_SERVER_USERNAME` is answered 401 (a known
// limit: DwarfAI stores the password only, ADR-017 item 1). The call timeout is 10 s, the bound the
// OpenCode answer channel uses too.
//
// Candidate decision (21 §6): no candidate, new code. The legacy
// `src/main/opencodePermissions/answerOpenCodePermission.ts` builds the same Basic header for its
// permission answers only; it is the asking module's candidate (ISSUE-229), not this driver's.
import type { DiagnosticsLog } from '../../../../../kernel/ports/diagnosticsLog'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'
import type { SecretReader } from '../../../../../kernel/ports/secretReader'
import type { ServerRequest } from './permissionMapping'
import { listSessionsRequest } from './serverRequests'

/** Who started the server: the person (attach with their stored password) or the Host. */
export type ServerOwner = 'person' | 'host'

export interface OpenCodeServerTarget {
  readonly owner: ServerOwner
  /** The server's origin, e.g. `http://127.0.0.1:4096`. */
  readonly url: string
}

/** One HTTP call as the transport sends it. */
export interface HttpCall {
  readonly url: string
  readonly method: ServerRequest['method']
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

/** The server's answer: its status and its body, parsed as JSON when it is JSON. */
export interface HttpReply {
  readonly status: number
  readonly body: unknown
}

export type HttpTransport = (call: HttpCall) => Promise<HttpReply>

export type UnreachableCause =
  'unauthorized' | 'not-loopback' | 'network' | 'no-answer' | 'http-status' | 'unexpected-reply'

export type ServerCallOutcome =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'unreachable'; readonly cause: UnreachableCause }
  | { readonly kind: 'unavailable'; readonly cause: 'secret-store' }

/** One session a server lists (`Session.id`, `Session.directory`). */
export interface OpenCodeServerSession {
  readonly providerSessionId: string
  readonly directory?: string
}

export type ListSessionsOutcome =
  | { readonly kind: 'ok'; readonly sessions: readonly OpenCodeServerSession[] }
  | Exclude<ServerCallOutcome, { kind: 'ok' }>

export interface OpenCodeServerClientDeps {
  readonly secretReader: SecretReader
  readonly http: HttpTransport
  readonly scheduler: Scheduler
  readonly log: DiagnosticsLog
}

/** How long one call waits for the server's answer. */
export const OPENCODE_SERVER_CALL_TIMEOUT_MS = 10_000

/** OpenCode's default server user (opencode.ai/docs/server). */
const OPENCODE_SERVER_USERNAME = 'opencode'
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

export class OpenCodeServerClient {
  constructor(
    private readonly target: OpenCodeServerTarget,
    private readonly deps: OpenCodeServerClientDeps
  ) {}

  /** Sends one request; never retried. */
  async call(request: ServerRequest): Promise<ServerCallOutcome> {
    const origin = loopbackOrigin(this.target.url)
    if (origin === null) return this.unreachable('not-loopback', 'not-loopback')

    let password: string | null = null
    if (this.target.owner === 'person') {
      const read = await this.deps.secretReader.read('opencode-password').catch(() => 'failed')
      if (read === 'timeout' || read === 'failed') {
        this.deps.log.record({
          ...FAILED,
          event: 'opencode-server.unavailable',
          causeClass: read === 'timeout' ? 'password-timeout' : 'password-read-failed'
        })
        return { kind: 'unavailable', cause: 'secret-store' }
      }
      password = read
    }

    const headers: Record<string, string> = { accept: 'application/json' }
    if (request.body !== undefined) headers['content-type'] = 'application/json'
    if (password !== null) headers.authorization = basic(OPENCODE_SERVER_USERNAME, password)
    const call: HttpCall = {
      url: `${origin}${request.path}`,
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
    }

    const reply = await this.send(call)
    if (reply === 'no-answer') return this.unreachable('no-answer', 'no-answer')
    if (reply === 'network') return this.unreachable('network', 'network')
    if (reply.status === 401) {
      return this.unreachable(
        'unauthorized',
        password === null ? 'password-not-set' : 'password-rejected',
        reply.status
      )
    }
    if (reply.status < 200 || reply.status > 299) {
      return this.unreachable('http-status', 'http-status', reply.status)
    }
    return { kind: 'ok', body: reply.body }
  }

  /** `GET /session`: the sessions the server holds. */
  async listSessions(): Promise<ListSessionsOutcome> {
    const outcome = await this.call(listSessionsRequest())
    if (outcome.kind !== 'ok') return outcome
    const sessions = sessionsOf(outcome.body)
    if (sessions === null) return this.unreachable('unexpected-reply', 'unexpected-reply')
    return { kind: 'ok', sessions }
  }

  private send(call: HttpCall): Promise<HttpReply | 'network' | 'no-answer'> {
    return new Promise((resolve) => {
      const timer = this.deps.scheduler.after(OPENCODE_SERVER_CALL_TIMEOUT_MS, () =>
        resolve('no-answer')
      )
      this.deps.http(call).then(
        (reply) => {
          timer.cancel()
          resolve(reply)
        },
        () => {
          timer.cancel()
          resolve('network')
        }
      )
    })
  }

  private unreachable(
    cause: UnreachableCause,
    causeClass: string,
    status?: number
  ): { readonly kind: 'unreachable'; readonly cause: UnreachableCause } {
    this.deps.log.record({
      ...FAILED,
      event: 'opencode-server.unreachable',
      causeClass,
      ...(status === undefined ? {} : { errCode: String(status) })
    })
    return { kind: 'unreachable', cause }
  }
}

const FAILED = {
  level: 'warn',
  subsystem: 'suppliers',
  provider: 'opencode',
  outcome: 'failed'
} as const

/** `http://<loopback host>[:port]` with nothing else, or null. */
function loopbackOrigin(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const bare =
    parsed.username === '' &&
    parsed.password === '' &&
    (parsed.pathname === '/' || parsed.pathname === '') &&
    parsed.search === '' &&
    parsed.hash === ''
  if (parsed.protocol !== 'http:' || !bare || !LOOPBACK_HOSTS.has(parsed.hostname)) return null
  return parsed.origin
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

/** `Session[]` → its ids and folders; unknown fields are ignored. Null when it is not a list. */
function sessionsOf(body: unknown): OpenCodeServerSession[] | null {
  if (!Array.isArray(body)) return null
  const sessions: OpenCodeServerSession[] = []
  for (const item of body as unknown[]) {
    if (item === null || typeof item !== 'object') return null
    const { id, directory } = item as { id?: unknown; directory?: unknown }
    if (typeof id !== 'string' || id === '') return null
    sessions.push(
      typeof directory === 'string'
        ? { providerSessionId: id, directory }
        : { providerSessionId: id }
    )
  }
  return sessions
}

/**
 * The production transport: the runtime's `fetch`, with redirects refused so the `Authorization`
 * header never follows a request to another address.
 */
export const fetchTransport: HttpTransport = async (call) => {
  const response = await fetch(call.url, {
    method: call.method,
    headers: call.headers,
    redirect: 'error',
    ...(call.body === undefined ? {} : { body: call.body })
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = text === '' ? null : (JSON.parse(text) as unknown)
  } catch {
    body = text
  }
  return { status: response.status, body }
}
