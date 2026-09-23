import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
  AgentLaunchResult,
  DwarfProvider,
  JevRouteLaunchRequest,
  JevRouteLaunchResult,
  TurnOutcome
} from '../domain/types'
import { NOT_LAUNCHABLE } from '../domain/launchProviders'
import {
  DelegationConcurrencyGate,
  type DelegationConcurrencyLimits
} from './delegationConcurrency'
import type {
  DelegateAcceptedBody,
  DelegateRefusedBody,
  DelegationRouting,
  ResultBody
} from './delegationProtocol'
import { resolveDelegationRouting } from './delegationRouting'
// Runtime values below come from the server-only twin, never
// `./delegationProtocol` directly — see `delegationServerProtocol.ts`'s own
// top comment for why (in short: that file, unlike this one, is also a
// runtime dependency of `jevMcpServer.js`'s own build, and importing a
// runtime value from it here would pull it into BOTH bundles).
import {
  DELEGATE_ROUTE,
  DELEGATION_TOKEN_HEADER,
  MAX_DELEGATION_BODY_BYTES,
  RESULT_ROUTE_PREFIX,
  delegationFailure,
  parseDelegateRequestBody
} from './delegationServerProtocol'
import { DelegationTicketRegistry } from './delegationTickets'
import { DelegationTokenRegistry, type DelegationParentContext } from './delegationTokens'

/**
 * The delegation service (#511 T3): a loopback listener in `HookServer`'s own
 * shape — 127.0.0.1 only, an ephemeral port, a per-launch token instead of a
 * per-install one — serving the exact wire contract `delegationProtocol.ts`
 * (T2) already defines: `POST /delegate` and `GET /result/<ticket>`.
 *
 * Composition only for the HTTP layer; every real decision is already pure
 * and proven in isolation — `DelegationTokenRegistry` (who a token belongs
 * to), `DelegationTicketRegistry` (a ticket's own lifecycle and bounded
 * retention), `DelegationConcurrencyGate` (the fan-out bound), and
 * `resolveDelegationRouting` (turning a Jev verdict into a routing or a
 * typed failure). This class's own job is the wire: parse a request, ask
 * those four for an answer, write the response — nothing here decides
 * routing, limits, or what a failure means.
 *
 * `issueLaunchToken`/`revoke` are the narrow port T4's injection adapters
 * call (#511 T4) — unused by this task itself, and exercised directly by
 * this file's own tests. Depth 1 is enforced structurally elsewhere (see
 * `DelegationTokenRegistry`'s own comment): this service never calls
 * `issueLaunchToken` for the children IT launches.
 */

const BIND_HOST = '127.0.0.1'

/**
 * The minimal shape of a launch request this service ever builds — see
 * `AgentLaunchRequest`; `routedByJev` is deliberately never set (depth 1),
 * pinned directly by `delegationService.test.ts`'s own LOW-7 test (#511): it
 * inspects the literal object handed to `launch` and asserts the property is
 * absent. T4's own injection adapter must keep this guarantee structural,
 * not conventional, when it wires the gate in: evaluate the depth check
 * (`delegationGate.ts`) INSIDE `launchAgent` itself, at the moment of each
 * real launch, and pass this service's own per-launch token the same way —
 * an argument to that one launch call — never either one by writing it into
 * a config file dropped in the mine, which a delegated child could read back
 * to falsify its own depth or impersonate a different parent's token.
 */
interface DelegationLaunchRequest {
  mineId: string
  provider: DwarfProvider
  prompt: string
  model?: string
  effort?: string
}

export interface DelegationServiceOptions {
  /** 0 asks the OS for a free port; tests rely on that. */
  port: number
  /**
   * The app's ONE real launch entry point — `AgentRuntime.launchAgent` bound
   * in production, so a delegated child is bookkept exactly like any other
   * launch (board visibility, kick/end support, early-failure reporting),
   * and told what its own turn concluded by callback — see
   * `LaunchAgentHooks.onConcluded` (`runtime.ts`) and
   * `RetainLaunchRequest.onConcluded` (`launchedSessions.ts`) for the "never
   * a hung ticket" guarantee this service leans on rather than re-implementing.
   */
  launch: (
    request: DelegationLaunchRequest,
    hooks: { onConcluded: (outcome: TurnOutcome) => void }
  ) => Promise<AgentLaunchResult>
  /** Ask Jev which provider/model/effort suits this subtask — `JevLaunchRouter.route` bound, the SAME instance every ordinary launch already asks. */
  route: (request: JevRouteLaunchRequest) => Promise<JevRouteLaunchResult>
  /**
   * Re-checked LIVE on every `/delegate` call, never only at token-issue
   * time (T4's own gate check, before injection): a key can be cleared, or
   * the delegation preference turned off, while a long-running parent
   * session's token is still perfectly valid.
   */
  keyConfigured: () => boolean
  delegationAllowed: () => Promise<boolean>
  generateToken?: () => string
  generateTicketId?: () => string
  limits?: DelegationConcurrencyLimits
  now?: () => number
  log?: (message: string) => void
}

/** One prompt for the delegated child: context first (sets the stage), then the task, exactly as the acceptance test fixes it. */
function combinedPrompt(task: string, context: string | undefined): string {
  return context === undefined ? task : `${context}\n\n${task}`
}

export class DelegationService {
  private readonly options: DelegationServiceOptions
  private readonly tokens: DelegationTokenRegistry
  private readonly tickets: DelegationTicketRegistry
  private readonly concurrency: DelegationConcurrencyGate
  private server: Server | null = null
  private boundPort = 0

  constructor(options: DelegationServiceOptions) {
    this.options = options
    this.tokens = new DelegationTokenRegistry(
      options.generateToken === undefined ? {} : { generateToken: options.generateToken }
    )
    this.tickets = new DelegationTicketRegistry({
      ...(options.generateTicketId === undefined
        ? {}
        : { generateTicketId: options.generateTicketId }),
      ...(options.now === undefined ? {} : { now: options.now })
    })
    this.concurrency = new DelegationConcurrencyGate(options.limits)
  }

  /** The port actually bound, which differs from the requested one when it was 0. */
  get port(): number {
    return this.boundPort
  }

  /** Resolves once bound; rejects (leaving nothing listening) when the port is taken. */
  async start(): Promise<void> {
    if (this.server !== null) return
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.options.log?.(`[mcp] Delegation listener failed on a request: ${String(error)}`)
        if (!response.writableEnded) response.writeHead(500).end()
      })
    })
    server.keepAliveTimeout = 1000

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.close()
        reject(error)
      }
      server.once('error', onError)
      server.listen(this.options.port, BIND_HOST, () => {
        server.removeListener('error', onError)
        const address = server.address()
        this.boundPort = typeof address === 'object' && address !== null ? address.port : 0
        this.server = server
        server.on('error', (error) =>
          this.options.log?.(`[mcp] Delegation listener error: ${String(error)}`)
        )
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === null) return
    this.server = null
    this.boundPort = 0
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }

  /** T4's own port (#511 T4): one token per parent launch, naming this service's own loopback origin. */
  issueLaunchToken(context: DelegationParentContext): { endpoint: string; token: string } {
    const token = this.tokens.issue(context)
    return { endpoint: `http://${BIND_HOST}:${this.boundPort}`, token }
  }

  /** T4's own port: forget a token whose parent launch has ended. A no-op for one this service never issued. */
  revoke(token: string): void {
    this.tokens.revoke(token)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? ''
    const url = request.url ?? ''
    const isDelegate = method === 'POST' && url === DELEGATE_ROUTE
    const isResult = method === 'GET' && url.startsWith(RESULT_ROUTE_PREFIX)
    if (!isDelegate && !isResult) {
      this.reply(request, response, 404)
      return
    }

    // Sweep opportunistically, on ordinary request traffic — no dedicated
    // timer of this service's own (this app's own load-safety rule): bounded
    // growth costs nothing extra as long as SOME request eventually arrives.
    this.tickets.sweep()

    const token = request.headers[DELEGATION_TOKEN_HEADER]
    const parent = typeof token === 'string' ? this.tokens.contextFor(token) : undefined
    if (parent === undefined || typeof token !== 'string') {
      // Dropped before the body is read, same discipline HookServer holds
      // for a bad token.
      this.reply(request, response, 401)
      return
    }

    if (isResult) {
      this.handleResult(response, url, token)
      return
    }

    await this.handleDelegate(request, response, token, parent)
  }

  private handleResult(response: ServerResponse, url: string, token: string): void {
    const ticketId = this.decodeTicketId(url)
    const state = ticketId === undefined ? undefined : this.tickets.get(ticketId, token)
    const body: ResultBody = state ?? {
      status: 'failed',
      failure: delegationFailure('unknown-ticket', 'No such ticket.')
    }
    this.writeJson(response, 200, body)
  }

  /**
   * Decodes the ticket id out of `/result/<ticket>`'s URL, or `undefined` for
   * one that cannot possibly be a real ticket — including a malformed `%`
   * escape, which `decodeURIComponent` THROWS on rather than returning
   * undefined for (#511 LOW-10: an uncaught throw here used to reach
   * `start`'s own top-level catch and answer 500). Folded into the exact
   * SAME `unknown-ticket` answer `handleResult` already gives an unissued or
   * wrongly-owned ticket, so a caller sending a garbled id learns nothing it
   * could not already tell from a well-formed guess that missed.
   */
  private decodeTicketId(url: string): string | undefined {
    try {
      return decodeURIComponent(url.slice(RESULT_ROUTE_PREFIX.length))
    } catch {
      return undefined
    }
  }

  private async handleDelegate(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
    parent: DelegationParentContext
  ): Promise<void> {
    const body = await this.readBody(request, response)
    if (body === undefined) return // 413 already answered, connection drained

    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      this.refuse(response, delegationFailure('invalid-response', 'The request body was not JSON.'))
      return
    }
    const parsed = parseDelegateRequestBody(json)
    if (parsed === undefined) {
      this.refuse(
        response,
        delegationFailure('invalid-response', 'The request body was not a well-formed delegation.')
      )
      return
    }

    if (!this.options.keyConfigured()) {
      this.refuse(response, delegationFailure('disabled', 'No TypeSafe key is configured.'))
      return
    }
    if (!(await this.options.delegationAllowed())) {
      this.refuse(response, delegationFailure('disabled', 'Subtask delegation is turned off.'))
      return
    }

    if (!this.concurrency.tryAcquire(token)) {
      this.refuse(
        response,
        delegationFailure('concurrency-limit', 'Too many delegated subtasks are already running.')
      )
      return
    }

    const prompt = combinedPrompt(parsed.task, parsed.context)
    let resolved: ReturnType<typeof resolveDelegationRouting>
    try {
      resolved = resolveDelegationRouting(await this.options.route({ prompt }))
    } catch (error) {
      // #511 LOW-3: `route` runs AFTER `tryAcquire` already reserved this
      // token's slot. Every failure branch below releases that slot
      // explicitly before answering — a bare `await` here would let a
      // throwing router skip all of them, leaking the slot forever (until
      // the whole token is revoked) and turning an ordinary refusal into an
      // unexplained 500 from `start`'s own top-level catch.
      this.concurrency.release(token)
      this.refuse(
        response,
        delegationFailure('launch-failed', `Routing the delegated child threw: ${String(error)}`)
      )
      return
    }
    if ('failure' in resolved) {
      this.concurrency.release(token)
      this.refuse(response, resolved.failure)
      return
    }

    const launched = await this.launchChild(parent, resolved.routing, prompt, token)
    if ('failure' in launched) {
      this.concurrency.release(token)
      this.refuse(response, launched.failure)
      return
    }

    const acceptedBody: DelegateAcceptedBody = {
      ticket: launched.ticket,
      routing: resolved.routing
    }
    this.writeJson(response, 202, acceptedBody)
  }

  /**
   * Launches the delegated child through the ONE injected `launch` port —
   * see `DelegationServiceOptions.launch`'s own comment for why this is the
   * real `AgentRuntime.launchAgent`, same mine, same registry, and never
   * `routedByJev` (depth 1). Settles the ticket and releases this token's
   * concurrency slot from the SAME `onConcluded` callback, exactly once,
   * whatever the child's own turn concluded — see `LaunchAgentHooks` for why
   * this never hangs.
   *
   * `onConcluded` is handed to `launch` BEFORE a ticket exists — there is
   * nothing to hand a ticket id to until `launch` itself has already
   * answered `launched: true` a few lines below — so a `pendingOutcome`
   * latch covers the (never actually observed, but not structurally
   * impossible for an injected fake) case of the callback firing before
   * `ticketId` is assigned, and applies it the moment the ticket is created
   * instead of assuming a firing order this class does not control.
   */
  private async launchChild(
    parent: DelegationParentContext,
    routing: DelegationRouting,
    prompt: string,
    token: string
  ): Promise<{ ticket: string } | { failure: ReturnType<typeof delegationFailure> }> {
    // A mutable box, never a `let` reassigned directly: `ticketId` has
    // nothing to hold until `launch` itself answers `launched: true` below,
    // so ESLint's own `prefer-const` (correctly) refuses a bare `let`
    // assigned along only one of this function's several return paths.
    const state: { ticketId?: string; pendingOutcome?: TurnOutcome } = {}
    const onConcluded = (outcome: TurnOutcome): void => {
      if (state.ticketId === undefined) {
        state.pendingOutcome = outcome
        return
      }
      this.tickets.resolveDone(state.ticketId, outcome)
      this.concurrency.release(token)
    }

    let result: AgentLaunchResult
    try {
      result = await this.options.launch(
        {
          mineId: parent.mineId,
          provider: routing.provider,
          prompt,
          ...(routing.model === undefined ? {} : { model: routing.model }),
          ...(routing.effort === undefined ? {} : { effort: routing.effort })
        },
        { onConcluded }
      )
    } catch (error) {
      return {
        failure: delegationFailure(
          'launch-failed',
          `The delegated child could not be started: ${String(error)}`
        )
      }
    }

    if (!result.launched) {
      const kind = result.error === NOT_LAUNCHABLE ? 'provider-not-launchable' : 'launch-failed'
      return { failure: delegationFailure(kind, result.error ?? 'The launch attempt failed.') }
    }

    state.ticketId = this.tickets.create(token, routing)
    if (state.pendingOutcome !== undefined) {
      this.tickets.resolveDone(state.ticketId, state.pendingOutcome)
      this.concurrency.release(token)
    }
    return { ticket: state.ticketId }
  }

  private refuse(response: ServerResponse, failure: ReturnType<typeof delegationFailure>): void {
    const body: DelegateRefusedBody = { failure }
    this.writeJson(response, 400, body)
  }

  private writeJson(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(text)
  }

  /**
   * Reads a capped body, or answers 413 and drains the connection — never
   * DESTROYS it (#511 LOW-6, a deliberate divergence from `HookServer`'s own
   * `request.destroy()`): the request and response share one TCP socket, and
   * destroying it while the client may still be sending sends a RST rather
   * than a clean FIN, which can take the already-written 413 response down
   * with it even after it was handed to the OS (observed directly, even with
   * the destroy deferred to the response's own `finish` event: a body large
   * enough to arrive across more than one `data` event reliably surfaced to
   * the caller as a connection reset instead of a 413, never the 32-KB, one-
   * event bodies this suite's own regression test happens to use). Once
   * refused, every further chunk is simply dropped rather than buffered —
   * `chunks` stops growing at the exact moment the cap is crossed — so
   * letting the stream keep flowing to its own natural `end` costs nothing.
   * `refused` is checked FIRST in the handler (not only before pushing a
   * chunk) so no later `data` event tries to answer a second time.
   */
  private async readBody(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      let size = 0
      const chunks: Buffer[] = []
      let refused = false
      request.on('data', (chunk: Buffer) => {
        if (refused) return
        size += chunk.length
        if (size > MAX_DELEGATION_BODY_BYTES) {
          refused = true
          response.writeHead(413).end()
          resolve(undefined)
          // Keep draining rather than `request.destroy()`-ing here: with the
          // client possibly still sending, destroying a socket that still
          // has unread inbound data sends a TCP RST, not a clean FIN — and a
          // RST can take the 413 response down with it even after it has
          // already been handed to the OS (observed directly: a body large
          // enough to arrive across several `data` events reliably surfaced
          // to the caller as a connection reset instead of a 413, EVEN when
          // the destroy was deferred to the response's own `finish` event).
          // Discarding every further chunk (never destroy) costs nothing —
          // `chunks` simply stops growing the moment the cap is crossed —
          // and the client's own body eventually ends on its own (#511 LOW-6).
          return
        }
        chunks.push(chunk)
      })
      request.on('error', () => {
        if (!refused) resolve(undefined)
      })
      request.on('end', () => {
        if (refused) return
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
    })
  }

  /** Answer a rejected request and drain it, so the caller never stalls. */
  private reply(request: IncomingMessage, response: ServerResponse, status: number): void {
    response.writeHead(status).end()
    request.resume()
  }
}
