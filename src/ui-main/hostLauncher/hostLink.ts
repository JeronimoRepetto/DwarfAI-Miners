// A `ui` connection to the running Host for the upgrade handshake (ADR-003 items 5, 6, 12, frozen;
// 14 §3.2): the Node adapter of upgradeFlow.ts's HostLink port, over any duplex stream (a named
// pipe or a Unix socket in production). HostClient (later: ISSUE-051) owns the window's long-lived
// connection, with subscribe, snapshot and reconnect; this one only says `hello`, sends the two
// handshake methods and watches for `host.closing`.
//
// - The hello uses role `ui` (B-M05 and B-M06 are `ui`-only) with this boot's uiToken, read from
//   `<hostDataDir>/run/ui.token` for this one frame, never logged and never kept.
// - First frame: `hello.ok` (strict schema) → attached; a protocol `error` frame → refused with its
//   code; a failed connect, a close or silence for HELLO_ANSWER_TIMEOUT_MS → unreachable.
// - After `hello.ok`: each `res` settles the call with its correlation id; a call still waiting when
//   the connection closes settles HOST_UNAVAILABLE. A `host.closing` evt records its reason, which
//   `closed` reports once the connection has closed; a close without one reports null.
// - Generation 1 is the only generation in v1 (ADR-002 D8 item 4 is dormant): there is no previous
//   generation to speak, so attaching with 'previous' is refused INCOMPATIBLE_GENERATION without a
//   connection.
import type { Duplex } from 'node:stream'
import { readFile } from 'node:fs/promises'
import {
  encodeFrame,
  evtFrameSchema,
  FrameDecoder,
  HOST_FRAME_SCHEMAS,
  helloOkSchema,
  protocolErrorCodeSchema,
  resFrameSchema,
  type Hello,
  type HelloOk,
  type HostMethods,
  type IpcError
} from '@dwarfai/contracts'
import type { CallAnswer, ClosingReason, HostAttach, HostLink, LinkMethod } from './upgradeFlow'

/** How long the attach waits for the first frame: the hello bound of ADR-003 item 5. */
export const HELLO_ANSWER_TIMEOUT_MS = 5_000

export interface HostLinkOpenerDeps {
  /** Opens one connection to the endpoint; rejects when nothing listens. */
  connect: () => Promise<Duplex>
  /** `<hostDataDir>/run/ui.token`. */
  tokenFile: string
  protocolVersion: number
  /** This UI build, as `hello.client` describes the caller. */
  client: Hello['client']
  /** Schedules the hello timeout; default `setTimeout`. */
  after?: (ms: number, run: () => void) => () => void
}

const UNAVAILABLE: IpcError = {
  code: 'HOST_UNAVAILABLE',
  message: 'the connection closed before the answer',
  retryable: true
}

export function createHostLinkOpener(
  deps: HostLinkOpenerDeps
): (generation: 'current' | 'previous') => Promise<HostAttach> {
  const after = deps.after ?? realAfter
  return async (generation) => {
    if (generation === 'previous') return { kind: 'refused', code: 'INCOMPATIBLE_GENERATION' }
    let socket: Duplex
    try {
      socket = await deps.connect()
    } catch {
      return { kind: 'unreachable' }
    }
    const token = await readFile(deps.tokenFile, 'utf8').catch(() => '')
    const hello: Hello = {
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: deps.protocolVersion,
      role: 'ui',
      token: token.trim(),
      client: deps.client
    }
    return new Promise<HostAttach>((resolve) => {
      const decoder = new FrameDecoder()
      let link: NodeHostLink | null = null
      let settled = false
      const answer = (attach: HostAttach): void => {
        if (settled) return
        settled = true
        cancel()
        if (attach.kind !== 'attached') socket.destroy()
        resolve(attach)
      }
      const cancel = after(HELLO_ANSWER_TIMEOUT_MS, () => answer({ kind: 'unreachable' }))
      socket.on('data', (chunk: Uint8Array) => {
        decoder.push(chunk)
        for (let next = decoder.next(); next !== null; next = decoder.next()) {
          if (next.kind !== 'frame') {
            socket.destroy()
            return
          }
          if (link !== null) {
            link.receive(next.message)
            continue
          }
          const ok = helloOkSchema.safeParse(next.message)
          if (ok.success) {
            decoder.helloOk()
            link = new NodeHostLink(socket, ok.data)
            answer({ kind: 'attached', link })
            continue
          }
          answer(refusalOf(next.message))
          return
        }
      })
      socket.on('error', () => {})
      // The Host ending its side ends the connection: no half-open link is kept.
      socket.once('end', () => socket.destroy())
      socket.once('close', () => {
        link?.ended()
        answer({ kind: 'unreachable' })
      })
      socket.write(encodeFrame(hello))
    })
  }
}

class NodeHostLink implements HostLink {
  readonly closed: Promise<ClosingReason | null>
  private closing: ClosingReason | null = null
  private nextId = 0
  private readonly waiting = new Map<string, (answer: CallAnswer<unknown>) => void>()
  private settleClosed: (reason: ClosingReason | null) => void = () => {}

  constructor(
    private readonly socket: Duplex,
    readonly helloOk: HelloOk
  ) {
    this.closed = new Promise((resolve) => (this.settleClosed = resolve))
  }

  call<M extends LinkMethod>(
    method: M,
    params: HostMethods[M]['params']
  ): Promise<CallAnswer<HostMethods[M]['result']>> {
    if (this.socket.destroyed) return Promise.resolve({ ok: false, error: UNAVAILABLE })
    this.nextId += 1
    const id = `u${this.nextId}`
    return new Promise((resolve) => {
      this.waiting.set(id, resolve as (answer: CallAnswer<unknown>) => void)
      this.socket.write(encodeFrame({ type: 'req', id, method, params }))
    })
  }

  close(): void {
    this.socket.destroy()
  }

  /** One frame after `hello.ok`. */
  receive(message: unknown): void {
    const res = resFrameSchema.safeParse(message)
    if (res.success) {
      const resolve = this.waiting.get(res.data.id)
      this.waiting.delete(res.data.id)
      resolve?.(res.data.ok ? { ok: true, result: res.data.result } : res.data)
      return
    }
    const evt = evtFrameSchema.safeParse(message)
    if (evt.success && evt.data.name === 'host.closing') {
      const closing = HOST_FRAME_SCHEMAS['host.closing'].safeParse(evt.data.data)
      if (closing.success) this.closing = closing.data.reason
    }
  }

  /** The connection closed: every waiting call is answered, then `closed` settles. */
  ended(): void {
    for (const resolve of this.waiting.values()) resolve({ ok: false, error: UNAVAILABLE })
    this.waiting.clear()
    this.settleClosed(this.closing)
  }
}

function refusalOf(message: unknown): HostAttach {
  if (typeof message === 'object' && message !== null) {
    const { type, code } = message as { type?: unknown; code?: unknown }
    const known = protocolErrorCodeSchema.safeParse(code)
    if (type === 'error' && known.success) return { kind: 'refused', code: known.data }
  }
  return { kind: 'unreachable' }
}

function realAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}
