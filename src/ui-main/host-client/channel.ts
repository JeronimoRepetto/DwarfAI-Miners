// One authenticated connection to the Host's UI endpoint (ADR-003 items 4–6, 9, 12, frozen; 14 §1.5, §3.2): the one
// seam-B connection implementation of UI main. HostClient holds its `notifier` and `ui` connections with it, and the
// upgrade handshake's link (hostLauncher/hostLink.ts, ISSUE-032) is a thin adapter over it, so UI main has one client.
//
// - `openChannel` connects, sends `hello` first with the role and this boot's uiToken, read from
//   `<hostDataDir>/run/ui.token` for this one frame, never logged, never kept (ADR-003 item 3), and reads the first
//   frame: `hello.ok` (strict schema) → open; a protocol `error` frame → refused with its code; a failed connect, a
//   close, an unexpected frame or silence for HELLO_ANSWER_TIMEOUT_MS → unreachable, `bound` when the connection was
//   accepted (something holds the endpoint, ADR-003 item 9: the hung-Host rule of ADR-002 D9 needs it), not when
//   nothing listens.
// - Open: `request` writes one `req` frame and returns its correlation id; each `res` and each `evt` (strict
//   envelope schemas) goes to its handler; `host.closing` (B-F05) is remembered, and `closed` settles with its reason
//   once the connection closed, or with null when it closed without one (a crash, a lost connection, `close()`).
// - Liveness (ADR-003 item 9, when `liveness` is on and the Host advertised `ping`, 14 §1.3): a `ping` (B-M02) after
//   LIVENESS_PING_MS without a frame sent; LIVENESS_SILENCE_MS without a frame received closes the connection, which
//   then counts as lost (HostClient moves to `reconnecting`, ADR-002 D9). A Host that cannot be pinged is never
//   held to the silence bound. `pingNow` pings at once (Electron `powerMonitor` `resume`, 13 FM-109), and `heard`
//   tells the caller of every frame received (the 60 s hung-Host bound counts from the last one).
// - Nothing here logs: a frame's content is never logged (14 §1.10); the caller logs names and codes.
import type { Duplex } from 'node:stream'
import {
  encodeFrame,
  evtFrameSchema,
  FrameDecoder,
  HOST_FRAME_SCHEMAS,
  helloOkSchema,
  isAdvertised,
  protocolErrorCodeSchema,
  resFrameSchema,
  type EvtFrame,
  type Hello,
  type HelloOk,
  type HostFrameData,
  type IpcError,
  type ProtocolErrorCode
} from '@dwarfai/contracts'

/** How long an attach waits for the first frame: the hello bound of ADR-003 item 5. */
export const HELLO_ANSWER_TIMEOUT_MS = 5_000
/** ADR-003 item 9: the UI pings after 5 s without sending a frame. */
export const LIVENESS_PING_MS = 5_000
/** ADR-003 item 9: 15 s without a frame from the Host → the connection is lost (`reconnecting`, ADR-002 D9). */
export const LIVENESS_SILENCE_MS = 15_000

/** The `host.closing` reason (14 B-F05). */
export type ClosingReason = HostFrameData['host.closing']['reason']

/** A call's answer: the Host's result, or its typed call error (14 §1.5). */
export type CallAnswer<R> = { ok: true; result: R } | { ok: false; error: IpcError }

/** Schedules `run` after `ms`; the answer cancels it. */
export type After = (ms: number, run: () => void) => () => void

export interface ChannelDeps {
  /** Opens one connection to the endpoint; rejects when nothing listens. */
  connect: () => Promise<Duplex>
  /** The uiToken of `<hostDataDir>/run/ui.token`; '' when it cannot be read. */
  readToken: () => Promise<string>
  protocolVersion: number
  /** This UI build, as `hello.client` describes the caller. */
  client: Hello['client']
  after: After
  /** Ping when idle and close on silence (ADR-003 item 9). */
  liveness: boolean
}

export type ChannelOpen =
  | { kind: 'open'; channel: HostChannel }
  | { kind: 'refused'; code: ProtocolErrorCode }
  /** No `hello.ok`: `bound` when a connection was accepted, false when nothing listens. */
  | { kind: 'unreachable'; bound: boolean }

export async function openChannel(
  deps: ChannelDeps,
  role: 'ui' | 'notifier'
): Promise<ChannelOpen> {
  let socket: Duplex
  try {
    socket = await deps.connect()
  } catch {
    return { kind: 'unreachable', bound: false }
  }
  const token = (await deps.readToken().catch(() => '')).trim()
  const hello: Hello = {
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: deps.protocolVersion,
    role,
    token,
    client: deps.client
  }
  return new Promise<ChannelOpen>((resolve) => {
    const decoder = new FrameDecoder()
    let channel: HostChannel | null = null
    let settled = false
    const answer = (open: ChannelOpen): void => {
      if (settled) return
      settled = true
      cancel()
      if (open.kind !== 'open') socket.destroy()
      resolve(open)
    }
    const cancel = deps.after(HELLO_ANSWER_TIMEOUT_MS, () =>
      answer({ kind: 'unreachable', bound: true })
    )
    socket.on('data', (chunk: Uint8Array) => {
      decoder.push(chunk)
      for (let next = decoder.next(); next !== null; next = decoder.next()) {
        if (next.kind !== 'frame') {
          socket.destroy()
          return
        }
        if (channel !== null) {
          channel.receive(next.message)
          continue
        }
        const ok = helloOkSchema.safeParse(next.message)
        if (ok.success) {
          decoder.helloOk()
          channel = new HostChannel(socket, role, ok.data, deps)
          answer({ kind: 'open', channel })
          continue
        }
        answer(refusalOf(next.message))
        return
      }
    })
    socket.on('error', () => {})
    // The Host ending its side ends the connection: no half-open channel is kept.
    socket.once('end', () => socket.destroy())
    socket.once('close', () => {
      channel?.ended()
      answer({ kind: 'unreachable', bound: true })
    })
    socket.write(encodeFrame(hello))
  })
}

export class HostChannel {
  readonly closed: Promise<ClosingReason | null>
  private closing: ClosingReason | null = null
  private isClosed = false
  private nextId = 0
  private settleClosed: (reason: ClosingReason | null) => void = () => {}
  private onResponse: (id: string, answer: CallAnswer<unknown>) => void = () => {}
  private onEvent: (frame: EvtFrame) => void = () => {}
  private onHeard: () => void = () => {}
  private readonly pings = new Set<string>()
  private cancelPing: () => void = () => {}
  private cancelSilence: () => void = () => {}

  constructor(
    private readonly socket: Duplex,
    readonly role: 'ui' | 'notifier',
    readonly helloOk: HelloOk,
    private readonly deps: Pick<ChannelDeps, 'after' | 'liveness'>
  ) {
    this.closed = new Promise((resolve) => (this.settleClosed = resolve))
    this.armPing()
    this.armSilence()
  }

  /** Whether the connection still carries frames. */
  get open(): boolean {
    return !this.isClosed && !this.socket.destroyed
  }

  /** Where each `res` goes, by correlation id. */
  responses(handler: (id: string, answer: CallAnswer<unknown>) => void): void {
    this.onResponse = handler
  }

  /** Where each `evt` frame goes, in arrival order. */
  events(handler: (frame: EvtFrame) => void): void {
    this.onEvent = handler
  }

  /** Called on every frame received after `hello.ok`, before it is handed on. */
  heard(handler: () => void): void {
    this.onHeard = handler
  }

  /** Pings at once when the Host can be pinged (13 FM-109); a closed connection sends nothing. */
  pingNow(): void {
    if (!this.deps.liveness || !isAdvertised(this.helloOk.capabilities, 'ping')) return
    this.request('ping', {}, (id) => this.pings.add(id))
  }

  /**
   * Writes one `req` frame and returns its correlation id, or null when the connection is closed. `register` runs
   * with the id before the frame is written, since its answer may arrive before `request` returns.
   */
  request(
    method: string,
    params: unknown,
    register: (id: string) => void = () => {}
  ): string | null {
    if (!this.open) return null
    this.nextId += 1
    const id = `${this.role === 'ui' ? 'u' : 'n'}${this.nextId}`
    register(id)
    this.socket.write(encodeFrame({ type: 'req', id, method, params }))
    this.armPing()
    return id
  }

  close(): void {
    this.socket.destroy()
  }

  /** One frame after `hello.ok`. */
  receive(message: unknown): void {
    this.armSilence()
    this.onHeard()
    const res = resFrameSchema.safeParse(message)
    if (res.success) {
      if (this.pings.delete(res.data.id)) return
      this.onResponse(
        res.data.id,
        res.data.ok ? { ok: true, result: res.data.result } : { ok: false, error: res.data.error }
      )
      return
    }
    const evt = evtFrameSchema.safeParse(message)
    if (!evt.success) return
    if (evt.data.name === 'host.closing') {
      const closing = HOST_FRAME_SCHEMAS['host.closing'].safeParse(evt.data.data)
      if (closing.success) this.closing = closing.data.reason
    }
    this.onEvent(evt.data as EvtFrame)
  }

  /** The connection closed: the timers stop, then `closed` settles. */
  ended(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.cancelPing()
    this.cancelSilence()
    this.settleClosed(this.closing)
  }

  private armPing(): void {
    this.cancelPing()
    if (!this.deps.liveness || !isAdvertised(this.helloOk.capabilities, 'ping')) return
    this.cancelPing = this.deps.after(LIVENESS_PING_MS, () => {
      this.request('ping', {}, (id) => this.pings.add(id))
    })
  }

  private armSilence(): void {
    this.cancelSilence()
    if (!this.deps.liveness || !isAdvertised(this.helloOk.capabilities, 'ping')) return
    this.cancelSilence = this.deps.after(LIVENESS_SILENCE_MS, () => this.socket.destroy())
  }
}

function refusalOf(message: unknown): ChannelOpen {
  if (typeof message === 'object' && message !== null) {
    const { type, code } = message as { type?: unknown; code?: unknown }
    const known = protocolErrorCodeSchema.safeParse(code)
    if (type === 'error' && known.success) return { kind: 'refused', code: known.data }
  }
  return { kind: 'unreachable', bound: true }
}
