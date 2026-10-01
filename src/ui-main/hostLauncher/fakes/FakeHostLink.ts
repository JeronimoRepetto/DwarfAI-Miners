// The HostLink double (16 §2.8 `Fake<Port>`): one scripted `ui` connection to a Host. It answers
// each method from a script, records every call it was sent, and settles `closed` when the test
// says the Host closed — with a `host.closing` reason, or with none (a crash or a lost connection).
// Never imported by production code (R14).
import { PROTOCOL_VERSION, type HelloOk, type HostMethods } from '@dwarfai/contracts'
import type { CallAnswer, ClosingReason, HostLink, LinkMethod } from '../upgradeFlow'

export interface FakeHostLinkOptions {
  protocolVersion?: number
  hostVersion?: string
  /** `hello.ok.capabilities`; default the two upgrade methods. */
  capabilities?: string[]
  /** The answer to each method; default success with the Host's own result. */
  answers?: Partial<{ [M in LinkMethod]: CallAnswer<HostMethods[M]['result']> }>
}

export class FakeHostLink implements HostLink {
  readonly helloOk: HelloOk
  /** Every call, in order. */
  readonly calls: Array<{ method: LinkMethod; params: unknown }> = []
  readonly closed: Promise<ClosingReason | null>
  closedByClient = false
  private settle: (reason: ClosingReason | null) => void = () => {}

  constructor(private readonly options: FakeHostLinkOptions = {}) {
    this.helloOk = {
      type: 'hello.ok',
      hostVersion: options.hostVersion ?? '0.20.0',
      buildId: 'abc1234',
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
      endpointGeneration: 1,
      epoch: 'epoch-fake',
      state: 'ready',
      jobStatus: 'n/a',
      capabilities: options.capabilities ?? ['host.shutdown', 'host.upgrade.request', 'ping'],
      clientId: 'client-fake'
    }
    this.closed = new Promise((resolve) => (this.settle = resolve))
  }

  call<M extends LinkMethod>(
    method: M,
    params: HostMethods[M]['params']
  ): Promise<CallAnswer<HostMethods[M]['result']>> {
    this.calls.push({ method, params })
    const scripted = this.options.answers?.[method] as
      CallAnswer<HostMethods[M]['result']> | undefined
    if (scripted !== undefined) return Promise.resolve(scripted)
    return Promise.resolve({ ok: true, result: defaultResult(method, params) })
  }

  close(): void {
    this.closedByClient = true
    this.settle(null)
  }

  /** The Host closed the connection, after `host.closing {reason}` or (null) without one. */
  hostClosed(reason: ClosingReason | null): void {
    this.settle(reason)
  }
}

function defaultResult<M extends LinkMethod>(
  method: M,
  params: HostMethods[M]['params']
): HostMethods[M]['result'] {
  if (method === 'host.upgrade.request') {
    return { state: 'upgrade-pending' } as HostMethods[M]['result']
  }
  const { mode } = params as HostMethods['host.shutdown']['params']
  const result: HostMethods['host.shutdown']['result'] =
    mode === 'stop-all'
      ? { mode: 'stop-all', outcome: { ended: [], failed: [] } }
      : { mode: 'upgrade-drain', accepted: true }
  return result as HostMethods[M]['result']
}
