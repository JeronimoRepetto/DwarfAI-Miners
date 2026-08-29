import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { HOOK_ROUTE, HOOK_TOKEN_HEADER } from './hookCommand'
import { parseClaudeHookPayload, type HookEvent } from './hookPayload'
import { tokensMatch } from './hookToken'

/**
 * Largest hook body accepted, in bytes. Claude's own payloads are a few
 * hundred bytes; the cap exists so a local process cannot make the main
 * process buffer arbitrary memory before the token is even checked.
 */
export const MAX_HOOK_BODY_BYTES = 4096

/** Loopback only. Never 0.0.0.0: this listener must not be reachable off-box. */
const BIND_HOST = '127.0.0.1'

export interface HookServerOptions {
  /** 0 asks the OS for a free port; tests rely on that. */
  port: number
  token: string
  onEvent: (event: HookEvent) => void
  log?: (message: string) => void
}

/**
 * The push half of the hybrid detection design: a loopback HTTP listener that
 * turns a Claude Code hook into an immediate rescan.
 *
 * Its contract towards the caller is "never get in the agent's way": every
 * response is immediate and empty-bodied, no request can block, and a failure
 * anywhere downstream is swallowed rather than surfaced as an HTTP error the
 * hook might act on. Its contract towards this machine is "prove you are the
 * hook we installed": every request carries the per-install token, and one
 * that does not is dropped before its body is even read.
 */
export class HookServer {
  private readonly options: HookServerOptions
  private server: Server | null = null
  private boundPort = 0

  constructor(options: HookServerOptions) {
    this.options = options
  }

  /** The port actually bound, which differs from the requested one when it was 0. */
  get port(): number {
    return this.boundPort
  }

  /** Resolves once bound; rejects (leaving nothing listening) when the port is taken. */
  async start(): Promise<void> {
    if (this.server !== null) return
    if (this.options.token === '') {
      throw new Error('[hooks] Refusing to listen without an install token')
    }

    const server = createServer((request, response) => this.handle(request, response))
    // A hook connection is one short POST; holding it open buys nothing and
    // would keep the process alive at quit time.
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
        // Later runtime errors must never take the app down with them.
        server.on('error', (error) =>
          this.options.log?.(`[hooks] Listener error: ${String(error)}`)
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

  private handle(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'POST' || request.url !== HOOK_ROUTE) {
      this.reply(request, response, 404)
      return
    }
    if (!tokensMatch(this.options.token, request.headers[HOOK_TOKEN_HEADER])) {
      // Dropped before the body is read: an unauthenticated caller never gets
      // to make this process buffer anything.
      this.reply(request, response, 401)
      return
    }

    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_HOOK_BODY_BYTES) {
        response.writeHead(413).end()
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', () => response.destroy())
    request.on('end', () => {
      if (response.writableEnded) return
      const event = parseClaudeHookPayload(Buffer.concat(chunks).toString('utf8'))
      if (event === null) {
        response.writeHead(400).end()
        return
      }
      // Answer first, then work: the hook process is waiting on this socket
      // and a slow scan must never show up as agent latency.
      response.writeHead(204).end()
      try {
        this.options.onEvent(event)
      } catch (error) {
        this.options.log?.(`[hooks] Event handler failed: ${String(error)}`)
      }
    })
  }

  /** Answer a rejected request and drain it, so the caller never stalls. */
  private reply(request: IncomingMessage, response: ServerResponse, status: number): void {
    response.writeHead(status).end()
    request.resume()
  }
}
