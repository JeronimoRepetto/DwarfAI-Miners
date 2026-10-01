// One connection to the UI endpoint (ADR-003 items 2, 4–6, 12, frozen; 14 §1.5): a duplex stream —
// a named pipe or Unix socket in production, an in-process pair in L6 — run through
// `awaiting-hello` → `authenticated(role, clientId)` → `closed`.
//
// - awaiting-hello: nothing is ever written before a valid hello (item 2; 18 C-11). The first
//   frame is answered by hello.ts: `hello.ok`, or one `error` frame with its code and no detail,
//   then the close. A 5 s timer on the injected Scheduler sends HELLO_TIMEOUT. Frames over 1 MiB.
// - authenticated: frames up to 8 MiB; each `req` is answered by the dispatcher. A second `hello`
//   gets PROTOCOL_ERROR and the close (item 5); any other frame that is not a valid `req`
//   envelope is the same protocol error, since it cannot be answered by correlation id.
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
import type { Dispatcher } from './dispatcher'
import { answerHello, type HelloDeps } from './hello'
import type { ChannelRole } from './roles'

/** The hello bound of ADR-003 item 5. */
export const HELLO_TIMEOUT_MS = 5_000

export interface ConnectionDeps extends HelloDeps {
  scheduler: Scheduler
  clock: Clock
  log: DiagnosticsLog
  dispatcher: Dispatcher
}

type ConnectionState =
  | { kind: 'awaiting-hello' }
  | { kind: 'authenticated'; role: ChannelRole; clientId: string }
  | { kind: 'closed' }

const SUBSYSTEM = 'transport'

/** Takes a freshly accepted connection; from here on the connection belongs to the transport. */
export function acceptConnection(stream: Duplex, deps: ConnectionDeps): void {
  let state: ConnectionState = { kind: 'awaiting-hello' }
  const decoder = new FrameDecoder()
  const record = (entry: Omit<DiagnosticEntry, 'subsystem'>): void =>
    deps.log.record({ ...entry, subsystem: SUBSYSTEM })
  const who = (): Pick<DiagnosticEntry, 'role' | 'connId'> =>
    state.kind === 'authenticated' ? { role: state.role, connId: state.clientId } : {}

  const isClosed = (): boolean => state.kind === 'closed'

  const write = (frame: unknown): void => {
    if (state.kind !== 'closed' && !stream.destroyed) stream.write(encodeFrame(frame))
  }

  /** Ends the connection. `error` is the one protocol error frame sent first, when there is one. */
  const close = (error?: ProtocolErrorCode): void => {
    if (state.kind === 'closed') return
    if (state.kind === 'authenticated') {
      record({
        level: 'info',
        event: 'channel.detach',
        ...who(),
        ...(error === undefined ? {} : { outcome: 'failed' as const, causeClass: error })
      })
    }
    state = { kind: 'closed' }
    helloTimer.cancel()
    if (error === undefined || stream.destroyed) {
      stream.destroy()
      return
    }
    const frame: ErrorFrame = { type: 'error', code: error }
    stream.end(encodeFrame(frame), () => stream.destroy())
  }

  const refuseHello = (code: ProtocolErrorCode): void => {
    record({ level: 'warn', event: 'channel.hello.refused', causeClass: code, ...who() })
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
      state = { kind: 'authenticated', role: answer.role, clientId: answer.helloOk.clientId }
      decoder.helloOk()
      write(answer.helloOk)
      record({ level: 'info', event: 'channel.attach', ...who() })
      return
    }
    if (state.kind !== 'authenticated') return
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

function isHello(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'hello'
  )
}
