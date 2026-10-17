// The shared line-framed JSON-RPC client over a child's stdio (15 §4.4 Transport, §0 "JSON-RPC
// request timeout"; HO-11). One JSON message per line, LF or CRLF. What the server writes is read
// into three queues: responses (each resolves its own waiter by id), server requests and
// notifications; within one read, server requests reach the owner before notifications, so an ask
// is always opened before a `serverRequest/resolved` read with it can close it. Every request has
// a 30 000 ms timeout on the Scheduler; the end of the server's output fails every pending waiter
// and is reported once. A server request the owner does not know is answered `-32601` and logged
// as drift: it opens no ask (15 §1.4, fail closed; FM-070). A malformed line is drift and skipped.
//
// Design from the JSON-RPC client of `al@e631d18:src/main/sessions-history.ts:675-783` (MIT; the
// idea, not the code) and Hermes' `request(..., timeout=30)` (HO-11). Never reads the process
// environment, never spawns: the driver hands it the child's streams.
import type { Readable, Writable } from 'node:stream'
import type { Scheduler } from '../../../../../kernel/ports/scheduler'

/** 15 §0: the JSON-RPC request timeout of the stdio clients. */
export const JSON_RPC_REQUEST_TIMEOUT_MS = 30_000
/** JSON-RPC 2.0 §5.1: the method does not exist or is not available. */
export const METHOD_NOT_FOUND = -32601

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  readonly id: JsonRpcId
  readonly method: string
  readonly params: unknown
}

export interface JsonRpcNotification {
  readonly method: string
  readonly params: unknown
}

/** A response to one of the owner's own requests, or a response whose id names no waiter. */
export interface JsonRpcResponse {
  readonly id: JsonRpcId
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

/** Why a request did not resolve: an error reply, no reply in time, or the transport ended. */
export type JsonRpcFailure =
  | { readonly kind: 'error'; readonly code: number; readonly message: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'closed' }

export interface JsonRpcStdioClientOptions {
  /** The server's output (the child's stdout). */
  readonly input: Readable
  /** The server's input (the child's stdin). */
  readonly output: Writable
  readonly scheduler: Scheduler
  readonly requestTimeoutMs?: number
  /** A server request; `false` when its method is unknown (it is then answered `-32601`). */
  readonly onRequest: (request: JsonRpcRequest) => boolean
  readonly onNotification: (notification: JsonRpcNotification) => void
  /** Protocol drift: a malformed line or message, an unknown server request (HO-33). */
  readonly onDrift: (detail: string) => void
  /** The server's output ended (EOF); called once, after the last message was handled. */
  readonly onEnd: () => void
  /** A response whose id names no pending request of the owner. */
  readonly onStrayResponse?: (response: JsonRpcResponse) => void
}

interface Waiter {
  readonly resolve: (value: unknown) => void
  readonly reject: (failure: JsonRpcFailure) => void
  readonly timer: { cancel(): void }
}

type Incoming =
  | { kind: 'response'; message: JsonRpcResponse }
  | { kind: 'request'; message: JsonRpcRequest }
  | { kind: 'notification'; message: JsonRpcNotification }

const CLOSED: JsonRpcFailure = Object.freeze({ kind: 'closed' })

export class JsonRpcStdioClient {
  private nextId = 1
  private readonly waiters = new Map<JsonRpcId, Waiter>()
  private readonly responses: JsonRpcResponse[] = []
  private readonly requests: JsonRpcRequest[] = []
  private readonly notifications: JsonRpcNotification[] = []
  private partial = ''
  private drainScheduled = false
  private inputEnded = false
  private endReported = false

  constructor(private readonly options: JsonRpcStdioClientOptions) {
    const { input } = options
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => this.read(chunk))
    input.once('end', () => this.inputEnd())
    input.once('close', () => this.inputEnd())
    input.on('error', () => this.inputEnd())
    options.output.on('error', () => undefined)
  }

  /** The server's output ended: no request can be answered any more. */
  get ended(): boolean {
    return this.endReported
  }

  /** Sends a request; resolves its result, or rejects a `JsonRpcFailure`. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.inputEnded || !this.writable()) return Promise.reject(CLOSED)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = this.options.scheduler.after(
        this.options.requestTimeoutMs ?? JSON_RPC_REQUEST_TIMEOUT_MS,
        () => {
          this.waiters.delete(id)
          reject({ kind: 'timeout' } satisfies JsonRpcFailure)
        }
      )
      this.waiters.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Answers a server request; false when the server's input is already closed. */
  respond(id: JsonRpcId, result: unknown): boolean {
    return this.write({ jsonrpc: '2.0', id, result })
  }

  /** Answers a server request with a JSON-RPC error; false when the input is already closed. */
  respondError(id: JsonRpcId, code: number, message: string): boolean {
    return this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  /** Ends the server's input (its stdin); the server decides when it exits. */
  close(): void {
    if (this.writable()) this.options.output.end()
  }

  // ---------- reading ----------

  private read(chunk: string): void {
    this.partial += chunk
    let newline = this.partial.indexOf('\n')
    while (newline !== -1) {
      const line = this.partial.slice(0, newline)
      this.partial = this.partial.slice(newline + 1)
      this.enqueue(line)
      newline = this.partial.indexOf('\n')
    }
    this.scheduleDrain()
  }

  private enqueue(raw: string): void {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.options.onDrift('malformed line')
      return
    }
    const incoming = classify(value)
    if (incoming === null) {
      this.options.onDrift('malformed message')
      return
    }
    if (incoming.kind === 'response') this.responses.push(incoming.message)
    else if (incoming.kind === 'request') this.requests.push(incoming.message)
    else this.notifications.push(incoming.message)
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return
    this.drainScheduled = true
    queueMicrotask(() => {
      this.drainScheduled = false
      this.drain()
    })
  }

  /** Responses, then server requests, then notifications (HO-11); then a pending end. */
  private drain(): void {
    for (let response = this.responses.shift(); response; response = this.responses.shift()) {
      this.settle(response)
    }
    for (let request = this.requests.shift(); request; request = this.requests.shift()) {
      if (this.options.onRequest(request)) continue
      this.respondError(request.id, METHOD_NOT_FOUND, 'Method not found')
      this.options.onDrift(`unknown server request ${request.method}`)
    }
    for (let note = this.notifications.shift(); note; note = this.notifications.shift()) {
      this.options.onNotification(note)
    }
    if (this.inputEnded) this.reportEnd()
  }

  private settle(response: JsonRpcResponse): void {
    const waiter = this.waiters.get(response.id)
    if (waiter === undefined) {
      this.options.onStrayResponse?.(response)
      return
    }
    this.waiters.delete(response.id)
    waiter.timer.cancel()
    if (response.error !== undefined) {
      waiter.reject({
        kind: 'error',
        code: response.error.code,
        message: response.error.message
      })
    } else {
      waiter.resolve(response.result ?? null)
    }
  }

  private inputEnd(): void {
    if (this.inputEnded) return
    this.inputEnded = true
    const last = this.partial
    this.partial = ''
    this.enqueue(last)
    this.scheduleDrain()
  }

  /** CH-04: every pending waiter fails, and the end is reported once. */
  private reportEnd(): void {
    if (this.endReported) return
    this.endReported = true
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id)
      waiter.timer.cancel()
      waiter.reject(CLOSED)
    }
    this.options.onEnd()
  }

  // ---------- writing ----------

  private writable(): boolean {
    const { output } = this.options
    return !output.writableEnded && !output.destroyed
  }

  private write(message: Record<string, unknown>): boolean {
    if (!this.writable()) return false
    this.options.output.write(`${JSON.stringify(message)}\n`)
    return true
  }
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

/** A request, a notification, a response, or `null` for anything else (malformed). */
function classify(value: unknown): Incoming | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  const { id, method } = message
  if (typeof method === 'string') {
    return isId(id)
      ? { kind: 'request', message: { id, method, params: message.params ?? null } }
      : { kind: 'notification', message: { method, params: message.params ?? null } }
  }
  if (!isId(id)) return null
  const error = message.error
  if (error !== undefined) {
    const e = (error ?? {}) as { code?: unknown; message?: unknown }
    return {
      kind: 'response',
      message: {
        id,
        error: {
          code: typeof e.code === 'number' ? e.code : 0,
          message: typeof e.message === 'string' ? e.message : ''
        }
      }
    }
  }
  if (!('result' in message)) return null
  return { kind: 'response', message: { id, result: message.result } }
}
