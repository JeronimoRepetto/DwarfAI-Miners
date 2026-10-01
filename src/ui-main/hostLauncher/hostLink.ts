// A `ui` connection to the running Host for the upgrade handshake (ADR-003 items 5, 6, 12, frozen;
// 14 §3.2): the Node adapter of upgradeFlow.ts's HostLink port. It is a thin adapter over the one
// seam-B connection of UI main, host-client/channel.ts (ISSUE-051), which HostClient also holds its
// connections with; this one only says `hello`, sends the two handshake methods and watches for
// `host.closing`.
//
// - The hello uses role `ui` (B-M05 and B-M06 are `ui`-only) with this boot's uiToken, read from
//   `<hostDataDir>/run/ui.token` for this one frame, never logged and never kept.
// - First frame: `hello.ok` (strict schema) → attached; a protocol `error` frame → refused with its
//   code; a failed connect, a close or silence for HELLO_ANSWER_TIMEOUT_MS → unreachable.
// - After `hello.ok`: each `res` settles the call with its correlation id; a call still waiting when
//   the connection closes settles HOST_UNAVAILABLE. A `host.closing` evt records its reason, which
//   `closed` reports once the connection has closed; a close without one reports null.
// - The link sends no liveness ping: it sends exactly the handshake's methods, as ISSUE-032 left it.
// - Generation 1 is the only generation in v1 (ADR-002 D8 item 4 is dormant): there is no previous
//   generation to speak, so attaching with 'previous' is refused INCOMPATIBLE_GENERATION without a
//   connection.
import type { Duplex } from 'node:stream'
import { readFile } from 'node:fs/promises'
import type { Hello, HelloOk, HostMethods, IpcError } from '@dwarfai/contracts'
import { HELLO_ANSWER_TIMEOUT_MS, openChannel, type HostChannel } from '../host-client/channel'
import type { CallAnswer, ClosingReason, HostAttach, HostLink, LinkMethod } from './upgradeFlow'

export { HELLO_ANSWER_TIMEOUT_MS }

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
    const opened = await openChannel(
      {
        connect: deps.connect,
        readToken: () => readFile(deps.tokenFile, 'utf8'),
        protocolVersion: deps.protocolVersion,
        client: deps.client,
        after,
        liveness: false
      },
      'ui'
    )
    if (opened.kind === 'open') return { kind: 'attached', link: new NodeHostLink(opened.channel) }
    return opened
  }
}

class NodeHostLink implements HostLink {
  readonly helloOk: HelloOk
  readonly closed: Promise<ClosingReason | null>
  private readonly waiting = new Map<string, (answer: CallAnswer<unknown>) => void>()

  constructor(private readonly channel: HostChannel) {
    this.helloOk = channel.helloOk
    channel.responses((id, answer) => {
      const resolve = this.waiting.get(id)
      this.waiting.delete(id)
      resolve?.(answer)
    })
    // Every call still waiting when the connection closed is answered, then `closed` settles.
    this.closed = channel.closed.then((reason) => {
      for (const resolve of this.waiting.values()) resolve({ ok: false, error: UNAVAILABLE })
      this.waiting.clear()
      return reason
    })
  }

  call<M extends LinkMethod>(
    method: M,
    params: HostMethods[M]['params']
  ): Promise<CallAnswer<HostMethods[M]['result']>> {
    return new Promise((resolve) => {
      const id = this.channel.request(method, params, (reserved) =>
        this.waiting.set(reserved, resolve as (answer: CallAnswer<unknown>) => void)
      )
      if (id === null) resolve({ ok: false, error: UNAVAILABLE })
    })
  }

  close(): void {
    this.channel.close()
  }
}

function realAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}
