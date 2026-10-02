import type {
  HostMethod,
  HostParams,
  HostResult,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'
import type {
  HostAvailability,
  HostClient,
  HostConnection,
  HostEvent,
  Presence
} from '../hostClient'

/** One call a `RecordingHostClient` received, by member name. */
export type HostClientCall =
  | { member: 'ensureHost' }
  | { member: 'call'; method: string; params: unknown }
  | { member: 'snapshot'; params: SnapshotParams }
  | { member: 'subscribe' }
  | { member: 'reportPresence'; presence: Presence }
  | { member: 'withUiConnection' }

/**
 * Recording double of `HostClient` (16 §4.14, 16 §2.8): a connected client that records every member a caller uses
 * that could reach the Host, and refuses every request, so a test proves what UI main sends to the Host. `deliver`
 * plays the client handing a Host event to each subscribed handler.
 */
export class RecordingHostClient implements HostClient {
  readonly calls: HostClientCall[] = []
  private readonly handlers = new Set<(e: HostEvent) => void>()

  ensureHost(): Promise<HostAvailability> {
    this.calls.push({ member: 'ensureHost' })
    return Promise.resolve('available')
  }

  state(): HostConnection {
    return { state: 'connected', hostVersion: '0.0.0-test', compat: false }
  }

  onStateChange(): () => void {
    return () => {}
  }

  capabilities(): readonly string[] {
    return []
  }

  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> {
    this.calls.push({ member: 'call', method, params })
    return Promise.reject(new Error(`RecordingHostClient answers no call (${method})`))
  }

  snapshot(p: SnapshotParams): Promise<SnapshotPage> {
    this.calls.push({ member: 'snapshot', params: p })
    return Promise.reject(new Error('RecordingHostClient answers no snapshot'))
  }

  subscribe(handler: (e: HostEvent) => void): () => void {
    this.calls.push({ member: 'subscribe' })
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  reportPresence(p: Presence): void {
    this.calls.push({ member: 'reportPresence', presence: p })
  }

  withUiConnection<T>(): Promise<T> {
    this.calls.push({ member: 'withUiConnection' })
    return Promise.reject(new Error('RecordingHostClient opens no ui connection'))
  }

  /** How many handlers are subscribed now. */
  get subscribers(): number {
    return this.handlers.size
  }

  /** The client hands `event` to every subscribed handler. */
  deliver(event: HostEvent): void {
    for (const handler of [...this.handlers]) handler(event)
  }
}
