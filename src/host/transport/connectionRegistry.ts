// The authenticated connections of the UI endpoint, and the one way a Host frame reaches them
// (ADR-003 items 6–8, 12, frozen; 14 §1.7–§1.9, §2.4 "Roles"). connection.ts attaches a connection
// here once its `hello.ok` is written and detaches it on every close; nothing before
// authentication is ever here, so no frame is sent before a valid hello (ADR-003 item 2).
//
// `publish` / `publishFrame` hand a frame to the frame publisher (events/framePublisher.ts), which
// numbers it per connection target, keeps it in the target's replay ring and sends it to every
// attached connection whose role the frame's FRAME_ROLES row names, and to no other: `host.state`
// reaches `ui` only, `host.closing` reaches `ui` and `notifier` (B-F04, B-F05), a viewer frame
// reaches only the viewers of the dwarf its audience names. `subscribe` is B-M03's
// (methods/eventsSubscribe.ts) and `resync` the outbound queue's, after a backpressure drain.
//
// `endAll` is the clean exit's: every connection is ended after the frames already written reach
// it, bounded so that a stalled client cannot hold the Host (the endpoint's close then destroys
// what is left).
import type { HostFrameData, HostFrameName, SubscribeParams } from '@dwarfai/contracts'
import type { Scheduler } from '../kernel/ports/scheduler'
import {
  FrameDelivery,
  type DeliveryConnection,
  type FrameAudience,
  type FrameValidator,
  type ResyncReason,
  type SubscribeOutcome
} from './events/framePublisher'

/** One authenticated connection as the registry drives it. */
export interface AttachedConnection extends DeliveryConnection {
  /** Ends the connection once every frame written so far has been handed to the peer. */
  end(): Promise<void>
}

/** What a Host frame publisher needs: the lifecycle state holder and the clean exit use it. */
export interface FramePublisher {
  publish<F extends HostFrameName>(name: F, data: HostFrameData[F]): void
}

export interface ConnectionRegistryOptions {
  /** Checks every published frame against its contract schema (14 §1.4): tests pass one. */
  validateFrame?: FrameValidator
}

export class ConnectionRegistry implements FramePublisher {
  private readonly delivery: FrameDelivery<AttachedConnection>
  private readonly attachListeners = new Set<(connection: AttachedConnection) => void>()
  private readonly detachListeners = new Set<(connection: AttachedConnection) => void>()

  constructor(options: ConnectionRegistryOptions = {}) {
    this.delivery = new FrameDelivery(options.validateFrame)
  }

  attach(connection: AttachedConnection): void {
    this.delivery.attach(connection)
    for (const listener of [...this.attachListeners]) listener(connection)
  }

  detach(connection: AttachedConnection): void {
    const attached = this.connections().includes(connection)
    this.delivery.detach(connection)
    if (attached) for (const listener of [...this.detachListeners]) listener(connection)
  }

  /**
   * Calls `listener` with each connection attached from now on, once it receives frames (its
   * `hello.ok` is written); returns the unsubscribe. The notifier's standing notifications are sent
   * from here (14 §2.3 "Notifier scope", ADR-018 item 5).
   */
  onAttach(listener: (connection: AttachedConnection) => void): () => void {
    this.attachListeners.add(listener)
    return () => this.attachListeners.delete(listener)
  }

  /**
   * Calls `listener` with each connection detached from now on (a close, or the clean exit's
   * `endAll`); returns the unsubscribe. The Reset saga's `ui-prefs` step stops waiting for a UI
   * that detached (07 S13.05).
   */
  onDetach(listener: (connection: AttachedConnection) => void): () => void {
    this.detachListeners.add(listener)
    return () => this.detachListeners.delete(listener)
  }

  /** The connections attached right now. */
  connections(): readonly AttachedConnection[] {
    return this.delivery.connections()
  }

  /** Publishes a frame to every role of its 14 §2.4 row. */
  publish<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
    this.delivery.publishFrame(name, data)
  }

  /** Publishes a frame to `audience` (roles within its 14 §2.4 row; for a viewer, its dwarf). */
  publishFrame<F extends HostFrameName>(
    name: F,
    data: HostFrameData[F],
    audience?: FrameAudience
  ): void {
    this.delivery.publishFrame(name, data, audience)
  }

  /** B-M03 for the attached connection `clientId` (14 §3.4). */
  subscribe(clientId: string, params: SubscribeParams, epoch: string): SubscribeOutcome {
    const connection = this.connections().find((attached) => attached.clientId === clientId)
    if (connection === undefined) throw new Error('events.subscribe from a connection not attached')
    return this.delivery.subscribe(connection, params, epoch)
  }

  /** The seq a snapshot built now for the attached connection `clientId` reflects (14 §4.2). */
  currentSeq(clientId: string): number {
    const connection = this.connections().find((attached) => attached.clientId === clientId)
    if (connection === undefined) throw new Error('a seq read for a connection not attached')
    return this.delivery.currentSeq(connection)
  }

  /** Sends one `resync-required` with `reason` to `connection` alone. */
  resync(connection: AttachedConnection, reason: ResyncReason): void {
    this.delivery.resync(connection, reason)
  }

  /**
   * Ends every attached connection; resolves when all of them ended or after `boundMs` on the
   * scheduler, whichever comes first.
   */
  async endAll(scheduler: Scheduler, boundMs: number): Promise<void> {
    const ends = this.connections().map((connection) => {
      this.detach(connection)
      return connection.end()
    })
    let timer: { cancel(): void } | undefined
    const bound = new Promise<void>((resolve) => {
      timer = scheduler.after(boundMs, resolve)
    })
    await Promise.race([Promise.all(ends).then(() => undefined), bound])
    timer?.cancel()
  }
}
