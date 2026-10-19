// One connect-and-`hello` attempt at the Host's UI endpoint (ADR-002 D4 item 1; ADR-003 item 5,
// frozen): the launcher's readiness probe. The full client (subscribe, snapshot, reconnect) is
// host-client/HostClient.ts (ISSUE-051); this sends only the first frame and reads only the first
// answer.
//
// - The hello uses the `notifier` role, the lowest scope that holds the uiToken: the launcher calls
//   nothing (the Host's own ALREADY_RUNNING probe does the same, host/transport/helloProbe.ts).
// - The token is read from `<hostDataDir>/run/ui.token` for this one frame, never logged, never
//   kept. A token that cannot be read (the Host has not written it yet) is sent empty; the Host
//   then refuses with AUTH_FAILED, which is still a Host's answer.
// - Answers: `hello.ok` (strict schema) → `hello-ok` with its state and job status; a protocol
//   `error` frame → `refused` with its code; a failed connect → `unreachable`; a close, silence for
//   PROBE_ANSWER_TIMEOUT_MS, or any other frame → `no-answer`. The connection is closed after the
//   first answer.
import type { Duplex } from 'node:stream'
import {
  encodeFrame,
  FrameDecoder,
  helloOkSchema,
  protocolErrorCodeSchema,
  type Hello
} from '@dwarfai/contracts'
import { readFile } from 'node:fs/promises'
import type { HelloAnswer, HelloProber } from './ports'

/** How long one attempt waits for the first frame: the hello bound of ADR-003 item 5. */
export const PROBE_ANSWER_TIMEOUT_MS = 5_000

export interface HelloProberDeps {
  /** Opens one connection to the endpoint; rejects when nothing listens. */
  connect: () => Promise<Duplex>
  /** `<hostDataDir>/run/ui.token`. */
  tokenFile: string
  protocolVersion: number
  /** This UI build, as `hello.client` describes the caller. */
  client: Hello['client']
  /** Schedules the answer timeout; default `setTimeout`. */
  after?: (ms: number, run: () => void) => () => void
}

export function createHelloProber(deps: HelloProberDeps): HelloProber {
  const after = deps.after ?? realAfter
  return async () => {
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
      role: 'notifier',
      token: token.trim(),
      client: deps.client
    }
    return new Promise<HelloAnswer>((resolve) => {
      const decoder = new FrameDecoder()
      let settled = false
      const settle = (answer: HelloAnswer): void => {
        if (settled) return
        settled = true
        cancel()
        socket.off('data', onData)
        socket.destroy()
        resolve(answer)
      }
      const onData = (chunk: Uint8Array): void => {
        decoder.push(chunk)
        const first = decoder.next()
        if (first !== null) settle(first.kind === 'frame' ? classify(first.message) : NO_ANSWER)
      }
      const cancel = after(PROBE_ANSWER_TIMEOUT_MS, () => settle(NO_ANSWER))
      socket.on('data', onData)
      socket.once('close', () => settle(NO_ANSWER))
      socket.once('end', () => settle(NO_ANSWER))
      socket.on('error', () => settle(NO_ANSWER))
      socket.write(encodeFrame(hello))
    })
  }
}

const NO_ANSWER: HelloAnswer = { kind: 'no-answer' }

function classify(message: unknown): HelloAnswer {
  const ok = helloOkSchema.safeParse(message)
  if (ok.success) return { kind: 'hello-ok', state: ok.data.state, jobStatus: ok.data.jobStatus }
  if (typeof message === 'object' && message !== null) {
    const { type, code } = message as { type?: unknown; code?: unknown }
    const known = protocolErrorCodeSchema.safeParse(code)
    if (type === 'error' && known.success) return { kind: 'refused', code: known.data }
  }
  return NO_ANSWER
}

function realAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}
