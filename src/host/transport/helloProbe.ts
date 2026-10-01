// The ADR-002 D3 hello probe (07 S12.02; 13 FM-009): owned here, no other issue owns it. When the
// UI endpoint is in use, the starting Host connects to it (endpoint/server.ts) and this probe asks
// whether a running Host holds it: it reads `run/ui.token`, sends a `hello` and waits for the
// first frame.
//
// - A Host answers a hello with `hello.ok` or with one protocol `error` frame (ADR-003 item 5).
//   Either proves a running Host holds the endpoint, so either is `answers-hello` and the new Host
//   exits ALREADY_RUNNING. A token that cannot be read (the running Host has not written it yet,
//   or the file is unreadable) is sent empty: the running Host refuses it with AUTH_FAILED, which
//   is still a Host's answer.
// - Anything else — silence for PROBE_HELLO_TIMEOUT_MS, a close, a frame that is not a seam-B
//   server frame, bytes that are not frames — is `no-hello`, and the boot fails without touching
//   the endpoint (FM-009, FM-037).
// - The hello uses the `notifier` role, the lowest scope that holds the uiToken: the probe calls
//   nothing. The token is read for this one frame and never logged.
import { readFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { encodeFrame, FrameDecoder, serverFrameSchema, type Hello } from '@dwarfai/contracts'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { ExistingEndpoint } from './endpoint/server'

/** How long the probe waits for the first frame: the hello bound of ADR-003 item 5. */
export const PROBE_HELLO_TIMEOUT_MS = 5_000

export interface HelloProbeDeps {
  /** `<hostDataDir>/run/ui.token`. */
  tokenFile: string
  scheduler: Scheduler
  protocolVersion: number
  /** This Host build, as `hello.client` describes the caller. */
  client: Hello['client']
}

export function createHelloProbe(
  deps: HelloProbeDeps
): (connection: Duplex) => Promise<ExistingEndpoint> {
  return async (connection) => {
    const token = await readFile(deps.tokenFile, 'utf8').catch(() => '')
    const hello: Hello = {
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: deps.protocolVersion,
      role: 'notifier',
      token: token.trim(),
      client: deps.client
    }
    return new Promise<ExistingEndpoint>((resolve) => {
      const decoder = new FrameDecoder()
      let settled = false
      const settle = (answer: ExistingEndpoint): void => {
        if (settled) return
        settled = true
        timer.cancel()
        connection.off('data', onData)
        resolve(answer)
      }
      const onData = (chunk: Uint8Array): void => {
        decoder.push(chunk)
        const first = decoder.next()
        if (first === null) return
        const isHostAnswer =
          first.kind === 'frame' &&
          isHelloAnswer(first.message) &&
          serverFrameSchema.safeParse(first.message).success
        settle(isHostAnswer ? 'answers-hello' : 'no-hello')
      }
      const timer = deps.scheduler.after(PROBE_HELLO_TIMEOUT_MS, () => settle('no-hello'))
      connection.on('data', onData)
      connection.once('close', () => settle('no-hello'))
      connection.on('error', () => settle('no-hello'))
      connection.write(encodeFrame(hello))
    })
  }
}

/** The two first frames a Host sends in answer to a hello. */
function isHelloAnswer(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const type = (message as { type?: unknown }).type
  return type === 'hello.ok' || type === 'error'
}
