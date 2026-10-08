// The Host's loopback HTTP ingress (ADR-016 items 2–3; 18 C-16b, T-39…T-41; 13 FM-038; 19 §9.2):
// one `node:http` listener for the integration channels' routes (`/hooks/claude/*` here; the
// OpenCode plugin's `/opencode/*` with ISSUE-229).
//
// Evaluated candidate: the legacy `hooks/hookServer.ts` (found tree) — replaced. It binds 127.0.0.1
// and answers before it works, which this file keeps; but it checks one shared plaintext token per
// install, caps bodies at 4 KiB, answers a closed route 404, and has no `Origin`, `Host` or rate
// check, each of which ADR-016 items 1–2 contradict.
//
// Every request, in order (the first refusal answers, with `connection: close`, and drains nothing
// into memory):
// 1. a path no route owns → 404 (no channel to log it under);
// 2. any `Origin` header → 403 `403-origin`: a browser page never reaches a route, and a CORS
//    preflight (which carries one) is never approved;
// 3. a `Host` header other than `127.0.0.1:<port>` → 403 `403-host` (DNS rebinding);
// 4. a method other than POST → 405;
// 5. above the channel's rate limit → 429 `rate-limited` (a sliding window on the Host clock);
// 6. the route's admission (integration gate and channel token) → 401, logged by the route;
// 7. a body above 256 KiB → 413 `413`: a declared `content-length` is refused before a byte is
//    read, a chunked body as soon as it passes the cap; the bytes are counted, never kept;
// 8. the route's schema → 400 `400`;
// 9. otherwise 204 with no body, and the route's delivery runs only once that is flushed: the
//    answer never waits for downstream work, and a failure there never reaches the caller.
// A dependency that throws at any step (the database under the admission, a route bug) is answered
// with a bodyless 500 `500`: nothing a request triggers escapes the listener (ADR-002 D7).
// Logged records carry the channel and the cause class only, never a token or a payload
// (NFR-SEC-12, ADR-026).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Instant } from '../../kernel/domain/values'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { TokenChannel } from '../../modules/preferences'
import { openIngressPort, type IngressPortRecord } from './ingressPort'

/** The only address the ingress listens on (ADR-016 item 2; never a hostname, never `0.0.0.0`). */
export const INGRESS_HOST = '127.0.0.1'
/** The body cap (ADR-016 item 2). */
export const MAX_INGRESS_BODY_BYTES = 256 * 1024
/**
 * The per-channel rate limit (ADR-016 item 2). Package gap (ISSUE-133): the package names no
 * figure. A Claude Code session sends a few hook events per tool call; 120 per second per channel
 * leaves room for many busy sessions at once and still bounds a local flood (T-40).
 */
export const INGRESS_RATE_LIMIT_REQUESTS = 120
/** The sliding window the rate limit counts in. */
export const INGRESS_RATE_LIMIT_WINDOW_MS = 1_000
/** A request whose headers and body have not all arrived by then is closed (T-40). */
export const INGRESS_REQUEST_TIMEOUT_MS = 10_000
/** A request whose headers have not all arrived by then is closed (slow-header flood, T-40). */
export const INGRESS_HEADERS_TIMEOUT_MS = 5_000
/** Open connections at once; one hook call is one short POST on its own connection. */
export const INGRESS_MAX_CONNECTIONS = 64
/** An idle kept-alive connection buys nothing and holds the Host's exit. */
const INGRESS_KEEP_ALIVE_TIMEOUT_MS = 1_000

/** The ingress listener's bounds on slow and parallel clients. */
export function applyIngressServerLimits(server: Server): Server {
  server.requestTimeout = INGRESS_REQUEST_TIMEOUT_MS
  server.headersTimeout = INGRESS_HEADERS_TIMEOUT_MS
  server.maxConnections = INGRESS_MAX_CONNECTIONS
  server.keepAliveTimeout = INGRESS_KEEP_ALIVE_TIMEOUT_MS
  return server
}
/** The custom header that carries a channel token (ADR-016 item 2). */
export const INGRESS_TOKEN_HEADER = 'x-dwarfai-token'

/** One channel's routes on the ingress. */
export interface IngressRoute {
  readonly channel: TokenChannel
  /** Every path that starts with it is this route's. */
  readonly prefix: string
  /** Integration gate and channel token; a refusal is logged by the route. */
  admits(token: unknown): boolean
  /** The delivery of a valid body, run after the answer, or `null` when the body is refused. */
  accept(body: string): (() => void) | null
}

export interface HttpIngressDeps {
  routes: readonly IngressRoute[]
  clock: Clock
  log: DiagnosticsLog
  /** `app_meta.ingress_port` (ADR-016 item 3). */
  portRecord: IngressPortRecord
  /** The persisted port was taken and replaced: the owned entries must be rewritten. */
  onPortChanged(port: number): void
}

export interface HttpIngress {
  /** Binds 127.0.0.1 on the persisted port (or a new one) and resolves with it. */
  start(): Promise<number>
  close(): Promise<void>
}

type CauseClass = '400' | '403-origin' | '403-host' | '413' | '500' | 'rate-limited'

export function createHttpIngress(deps: HttpIngressDeps): HttpIngress {
  const recent = new Map<TokenChannel, Instant[]>()
  let server: Server | null = null
  let port = 0

  const reject = (channel: TokenChannel, causeClass: CauseClass): void => {
    deps.log.record({ level: 'warn', event: 'ingress.rejected', subsystem: channel, causeClass })
  }

  /**
   * A dependency that threw (a locked database under the admission, a bug in a route): a bodyless
   * 500 and the cause class only, never the error, whose text could carry a token or a payload.
   * Package gap (ISSUE-133): 500 rather than 401, because no credential verdict was reached; both
   * are a non-blocking hook failure to Claude Code. The Host never exits on its own (ADR-002 D7),
   * so nothing a request triggers may escape the listener.
   */
  const fail = (
    request: IncomingMessage,
    response: ServerResponse,
    channel: TokenChannel
  ): void => {
    reject(channel, '500')
    try {
      answer(request, response, 500)
    } catch {
      response.destroy()
    }
  }

  /**
   * Counts one request of `channel` now; false once the window is full. Unauthenticated requests
   * count too (before the token check, so a flood costs no hashing): another local process can
   * then crowd out the real hooks for a moment, but the ingress is loopback only and Claude Code
   * treats a 429 as a non-blocking hook failure, so only a nudge is lost and observation's polling
   * still sees the change (FM-038).
   */
  const withinRate = (channel: TokenChannel): boolean => {
    const now = deps.clock.now()
    const window = (recent.get(channel) ?? []).filter(
      (at) => now - at < INGRESS_RATE_LIMIT_WINDOW_MS
    )
    const admitted = window.length < INGRESS_RATE_LIMIT_REQUESTS
    if (admitted) window.push(now)
    recent.set(channel, window)
    return admitted
  }

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const path = (request.url ?? '').split('?')[0] ?? ''
    const owner = deps.routes.find((candidate) => path.startsWith(candidate.prefix))
    if (owner === undefined) return answer(request, response, 404)
    try {
      serve(owner, request, response)
    } catch {
      fail(request, response, owner.channel)
    }
  }

  /** Steps 2–9 for a request `owner` owns; anything that throws is answered by `fail`. */
  const serve = (owner: IngressRoute, request: IncomingMessage, response: ServerResponse): void => {
    const channel = owner.channel
    if (request.headers.origin !== undefined) {
      reject(channel, '403-origin')
      return answer(request, response, 403)
    }
    if (request.headers.host !== `${INGRESS_HOST}:${port}`) {
      reject(channel, '403-host')
      return answer(request, response, 403)
    }
    if (request.method !== 'POST') return answer(request, response, 405)
    if (!withinRate(channel)) {
      reject(channel, 'rate-limited')
      return answer(request, response, 429)
    }
    if (!owner.admits(request.headers[INGRESS_TOKEN_HEADER])) {
      return answer(request, response, 401)
    }
    const declared = Number(request.headers['content-length'] ?? '0')
    if (!(declared <= MAX_INGRESS_BODY_BYTES)) {
      reject(channel, '413')
      return answer(request, response, 413)
    }
    readCapped(request, (body) => {
      try {
        finish(owner, body, request, response)
      } catch {
        fail(request, response, channel)
      }
    })
  }

  /** Steps 7–9 once the body is read (or passed the cap). */
  const finish = (
    owner: IngressRoute,
    body: string | null,
    request: IncomingMessage,
    response: ServerResponse
  ): void => {
    if (body === null) {
      reject(owner.channel, '413')
      return answer(request, response, 413)
    }
    const delivery = owner.accept(body)
    if (delivery === null) {
      reject(owner.channel, '400')
      return answer(request, response, 400)
    }
    // The delivery runs once the answer is flushed: the hook never waits for downstream work, and
    // a failure there can no longer reach it.
    response.writeHead(204).end(() => {
      try {
        delivery()
      } catch {
        // Never surfaced to the caller: it already has its answer.
      }
    })
  }

  return {
    async start(): Promise<number> {
      if (server !== null) return port
      const created = applyIngressServerLimits(createServer(handle))
      created.on('clientError', (_error, socket) => socket.destroy())
      server = created
      port = await openIngressPort({
        record: deps.portRecord,
        log: deps.log,
        onPortChanged: deps.onPortChanged,
        listen: (wanted) => listen(created, wanted)
      })
      return port
    },
    async close(): Promise<void> {
      const closing = server
      server = null
      port = 0
      if (closing === null || !closing.listening) return
      closing.closeAllConnections()
      await new Promise<void>((resolve) => closing.close(() => resolve()))
    }
  }
}

/** Binds `server` on 127.0.0.1:`port` (0 asks the OS); a port in use resolves `'taken'`. */
function listen(server: Server, port: number): Promise<{ bound: number } | 'taken'> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve('taken')
      else reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      resolve({ bound: typeof address === 'object' && address !== null ? address.port : 0 })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ port, host: INGRESS_HOST, exclusive: true })
  })
}

/**
 * The body as text, or `null` as soon as it passes the cap. Bytes past the cap are counted and
 * dropped, never kept.
 */
function readCapped(request: IncomingMessage, done: (body: string | null) => void): void {
  const chunks: Buffer[] = []
  let size = 0
  let settled = false
  request.on('data', (chunk: Buffer) => {
    if (settled) return
    size += chunk.length
    if (size > MAX_INGRESS_BODY_BYTES) {
      settled = true
      chunks.length = 0
      done(null)
      return
    }
    chunks.push(chunk)
  })
  request.on('end', () => {
    if (settled) return
    settled = true
    done(Buffer.concat(chunks).toString('utf8'))
  })
  request.on('error', () => {
    settled = true
  })
}

/** A refusal: the status, no body, the connection closed, and the request drained unread. */
function answer(request: IncomingMessage, response: ServerResponse, status: number): void {
  if (!response.headersSent) response.writeHead(status, { connection: 'close' }).end()
  request.resume()
}
