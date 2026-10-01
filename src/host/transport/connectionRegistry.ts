// The authenticated connections of the UI endpoint, and the one way a Host frame reaches them
// (ADR-003 items 6, 12, frozen; 14 §2.4 "Roles"). connection.ts attaches a connection here once its
// `hello.ok` is written and detaches it on every close; nothing before authentication is ever here,
// so no frame is sent before a valid hello (ADR-003 item 2).
//
// `publish` sends one `evt` frame to every attached connection whose role the frame's FRAME_ROLES
// row names, and to no other: `host.state` reaches `ui` only, `host.closing` reaches `ui` and
// `notifier` (B-F04, B-F05). Each connection numbers its own frames (`seq`, per connection,
// monotonic from 1 after `hello.ok`, 14 §3.2). The replay ring, the outbound high-water rule and
// the per-dwarf audience of a `viewer` are the event plumbing's (later: ISSUE-025), which takes
// over the delivery behind this same `publish`.
//
// `endAll` is the clean exit's: every connection is ended after the frames already written reach
// it, bounded so that a stalled client cannot hold the Host (the endpoint's close then destroys
// what is left).
import type { HostFrameData, HostFrameName } from '@dwarfai/contracts'
import type { Scheduler } from '../kernel/ports/scheduler'
import { FRAME_ROLES, type ChannelRole } from './roles'

/** One authenticated connection as the registry drives it. */
export interface AttachedConnection {
  readonly role: ChannelRole
  readonly clientId: string
  /** Writes one `evt` frame with this connection's next `seq`. */
  send<F extends HostFrameName>(name: F, data: HostFrameData[F]): void
  /** Ends the connection once every frame written so far has been handed to the peer. */
  end(): Promise<void>
}

/** What a Host frame publisher needs: the lifecycle state holder and the clean exit use it. */
export interface FramePublisher {
  publish<F extends HostFrameName>(name: F, data: HostFrameData[F]): void
}

export class ConnectionRegistry implements FramePublisher {
  private readonly attached = new Set<AttachedConnection>()

  attach(connection: AttachedConnection): void {
    this.attached.add(connection)
  }

  detach(connection: AttachedConnection): void {
    this.attached.delete(connection)
  }

  /** The connections attached right now. */
  connections(): readonly AttachedConnection[] {
    return [...this.attached]
  }

  publish<F extends HostFrameName>(name: F, data: HostFrameData[F]): void {
    const roles = FRAME_ROLES[name] ?? []
    for (const connection of this.connections()) {
      if (roles.includes(connection.role)) connection.send(name, data)
    }
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
