// One connection to the UI endpoint (ADR-003 items 2, 4–6, 12, frozen; 14 §1.5): a duplex stream —
// a named pipe or Unix socket in production, an in-process pair in L6 — run through
// `awaiting-hello` → `authenticated(role, clientId)` → `closed`.
//
// - awaiting-hello: nothing is ever written before a valid hello (item 2; 18 C-11). The first
//   frame is answered by hello.ts: `hello.ok`, or one `error` frame with its code and no detail,
//   then the close. A 5 s timer on the injected Scheduler sends HELLO_TIMEOUT. Frames over 1 MiB.
// - authenticated: frames up to 8 MiB; each `req` is answered by the dispatcher. A connection
//   that sends no whole frame for 15 s is a detached client (liveness.ts, ADR-003 item 9): it is
//   closed without a frame and `channel.detach` is logged with reason `silent`. A second `hello`
//   gets PROTOCOL_ERROR and the close (item 5); any other frame that is not a valid `req`
//   envelope is the same protocol error, since it cannot be answered by correlation id. Once
//   `hello.ok` is written the connection is attached to the ConnectionRegistry, which sends it
//   the Host frames of its role as `evt` frames numbered by this connection's `seq`, and which
//   the clean exit uses to end it after `host.closing` (ADR-003 item 12).
// - Throttle (ADR-003 item 5; 14 §1.5): every hello refusal counts as one failure; the fifth within
//   60 s logs `channel.rate-limited` once, with the count, and for 10 s each new connection gets
//   one `error {code:'RATE_LIMITED'}` frame and the close, before reading anything.
// - In either state a frame over the cap closes the connection without a frame (14 §1.5), and a
//   body that is not UTF-8 JSON is a PROTOCOL_ERROR, never a crash (16 §2.1).
// - closed: every later byte is ignored and nothing more is written.
//
// The log carries names, codes, sizes and ids only (14 §1.10; 19 §9.2), never a frame's content.
import type { Duplex } from 'node:stream'
import {
  encodeFrame,
  FrameDecoder,
  reqFrameSchema,
  type ErrorFrame,
  type ProtocolErrorCode
} from '@dwarfai/contracts'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticEntry, DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { HelloThrottle } from './auth/throttle'
import type { AttachedConnection, ConnectionRegistry } from './connectionRegistry'
import type { Dispatcher } from './dispatcher'
import { answerHello, type HelloDeps } from './hello'
import { watchSilence, type SilenceWatch } from './liveness'
import type { ChannelRole } from './roles'

/** The hello bound of ADR-003 item 5. */
export const HELLO_TIMEOUT_MS = 5_000

export interface ConnectionDeps extends HelloDeps {
  scheduler: Scheduler
  clock: Clock
  log: DiagnosticsLog
  dispatcher: Dispatcher
  /** Where the connection is attached once authenticated, so Host frames reach it. */
  connections: ConnectionRegistry
  /** The endpoint's failed-hello throttle, shared by every connection of the endpoint. */
  throttle: HelloThrottle
}

type ConnectionState =
  | { kind: 'awaiting-hello' }
  | {
      kind: 'authenticated'
      role: ChannelRole
      clientId: string
      attached: AttachedConnection
      silence: SilenceWatch
    }
  | { kind: 'closed' }

const SUBSYSTEM = 'transport'

/** Takes a freshly accepted connection; from here on the connection belongs to the transport. */
export function acceptConnection(stream: Duplex, deps: ConnectionDeps): void {
  if (!deps.throttle.admits()) {
    refuseThrottled(stream)
    return
  }
  let state: ConnectionState = { kind: 'awaiting-hello' }
  /** The `seq` of the last `evt` frame written: per connection, from 1 after hello.ok (14 §3.2). */
  let seq = 0
  const decoder = new FrameDecoder()
  const record = (entry: Omit<DiagnosticEntry, 'subsystem'>): void =>
    deps.log.record({ ...entry, subsystem: SUBSYSTEM })
  const who = (): Pick<DiagnosticEntry, 'role' | 'connId'> =>
    state.kind === 'authenticated' ? { role: state.role, connId: state.clientId } : {}

  const isClosed = (): boolean => state.kind === 'closed'

  const write = (frame: unknown): void => {
    if (state.kind !== 'closed' && !stream.destroyed) stream.write(encodeFrame(frame))
  }

  /**
   * Moves to `closed`: an authenticated connection is detached, its silence watch stopped and
   * `channel.detach` logged once, with `detail` (why the Host ended it, when it did).
   */
  const leave = (detail: Pick<DiagnosticEntry, 'outcome' | 'causeClass'> = {}): void => {
    if (state.kind === 'authenticated') {
      record({ level: 'info', event: 'channel.detach', ...who(), ...detail })
      deps.connections.detach(state.attached)
      state.silence.stop()
    }
    state = { kind: 'closed' }
    helloTimer.cancel()
  }

  /** Ends the connection. `error` is the one protocol error frame sent first, when there is one. */
  const close = (error?: ProtocolErrorCode): void => {
    if (state.kind === 'closed') return
    leave(error === undefined ? {} : { outcome: 'failed', causeClass: error })
    if (error === undefined || stream.destroyed) {
      stream.destroy()
      return
    }
    const frame: ErrorFrame = { type: 'error', code: error }
    stream.end(encodeFrame(frame), () => stream.destroy())
  }

  /**
   * Ends the connection without an error frame, once every frame written so far has been handed
   * to the peer (the clean exit's: `host.closing` is written first, ADR-003 item 12).
   */
  const end = (): Promise<void> => {
    if (state.kind === 'closed') return Promise.resolve()
    leave()
    if (stream.destroyed) return Promise.resolve()
    return new Promise((resolve) => {
      stream.once('close', () => resolve())
      stream.end(() => stream.destroy())
    })
  }

  /** 15 s without a frame: a detached client, closed without a frame (ADR-003 item 9). */
  const detachSilent = (): void => {
    if (state.kind !== 'authenticated') return
    leave({ causeClass: 'silent' })
    stream.destroy()
  }

  const refuseHello = (code: ProtocolErrorCode): void => {
    record({ level: 'warn', event: 'channel.hello.refused', causeClass: code, ...who() })
    const verdict = deps.throttle.recordFailure()
    if (verdict.engaged)
      record({ level: 'warn', event: 'channel.rate-limited', count: verdict.count })
    close(code)
  }

  const helloTimer = deps.scheduler.after(HELLO_TIMEOUT_MS, () => {
    if (state.kind === 'awaiting-hello') refuseHello('HELLO_TIMEOUT')
  })

  const onFrame = (message: unknown): void => {
    if (state.kind === 'awaiting-hello') {
      const answer = answerHello(message, deps)
      if (answer.kind === 'refused') {
        refuseHello(answer.code)
        return
      }
      helloTimer.cancel()
      const attached: AttachedConnection = {
        role: answer.role,
        clientId: answer.helloOk.clientId,
        send: (name, data) => {
          seq += 1
          write({ type: 'evt', seq, epoch: deps.epoch, name, data })
        },
        end: () => end()
      }
      state = {
        kind: 'authenticated',
        role: answer.role,
        clientId: answer.helloOk.clientId,
        attached,
        silence: watchSilence(deps.scheduler, detachSilent)
      }
      decoder.helloOk()
      write(answer.helloOk)
      deps.connections.attach(attached)
      record({ level: 'info', event: 'channel.attach', ...who() })
      return
    }
    if (state.kind !== 'authenticated') return
    state.silence.heard()
    if (isHello(message)) {
      refuseHello('PROTOCOL_ERROR')
      return
    }
    const request = reqFrameSchema.safeParse(message)
    if (!request.success) {
      close('PROTOCOL_ERROR')
      return
    }
    const context = { role: state.role, clientId: state.clientId }
    void deps.dispatcher.dispatch(request.data, context).then(write)
  }

  stream.on('data', (chunk: Uint8Array) => {
    if (state.kind === 'closed') return
    decoder.push(chunk)
    for (let next = decoder.next(); next !== null; next = decoder.next()) {
      if (next.kind === 'oversize') {
        record({ level: 'error', event: 'channel.frame.oversize', bytes: next.bytes, ...who() })
        close()
        return
      }
      if (next.kind === 'malformed') {
        if (state.kind === 'awaiting-hello') refuseHello('PROTOCOL_ERROR')
        else close('PROTOCOL_ERROR')
        return
      }
      onFrame(next.message)
      // onFrame may have closed the connection: nothing after that frame is read.
      if (isClosed()) return
    }
  })
  stream.on('error', () => close())
  stream.once('close', () => close())
}

/** A connection that arrived during a throttle refusal: one RATE_LIMITED frame, then the close. */
function refuseThrottled(stream: Duplex): void {
  const frame: ErrorFrame = { type: 'error', code: 'RATE_LIMITED' }
  stream.on('error', () => {})
  stream.end(encodeFrame(frame), () => stream.destroy())
}

function isHello(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'hello'
  )
}
