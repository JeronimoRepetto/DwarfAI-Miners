// The Host's one frame delivery path (ADR-003 items 6–8, frozen; 14 §1.7–§1.9, §2.4, §3.4, §3.5):
// `publishFrame(name, data, audience)` numbers a frame and hands it to every attached connection of
// its audience. Module events are published after commit on the in-process bus and the wiring
// routes each to `publishFrame` (16 §2.3); the Host lifecycle publishes through it too.
//
// Connection targets. A frame is numbered per connection target, not per write:
// - `ui`: one target for every `ui` connection, with the replay ring (512 events or 4 MiB). It
//   keeps numbering and holding frames while no window is attached, so a window that reconnects
//   to the same epoch resumes where it left (ADR-003 item 8).
// - `viewer`: one target per bound dwarf, with its ring; a viewer receives only the frames whose
//   audience names its dwarf (ADR-031 item 2), and a viewer frame that names no dwarf reaches no
//   viewer.
// - `notifier`: one target per connection, without a ring: there is no replay for the notifier
//   (14 §2.3 "Notifier scope"); it receives its frames without subscribing.
// Each target's `seq` is monotonic from 1 in the epoch, and each connection of a target receives
// its frames in that order, so `seq` is monotonic per connection (14 §1.7). A connection receives
// the frames of its role from `hello.ok` on.
//
// `events.subscribe` (B-M03, 14 §3.4), per connection:
// - no `resume` → `live` with the next seq; the client reads the snapshot next.
// - `resume` with another epoch → `resync-required`, and a `resync-required {epoch-changed}`
//   frame follows.
// - `resume` whose `lastSeq` the target's ring still covers → `replaying {fromSeq, toSeq}`, and
//   exactly the missed frames follow, in order, then the live ones.
// - otherwise → `resync-required`, and a `resync-required {seq-not-in-ring}` frame follows.
// The result is written first and the frames that follow it after (`release`, run by the
// connection once the result is written); frames published meanwhile wait behind them.
//
// A `resync-required` addressed to one connection (a subscribe outcome, or `backpressure` after
// its outbound queue drained, outbound.ts) takes its target's next seq but is not held in the
// ring: the target's other connections see that seq skipped, as they do for a coalesced frame.
//
// A frame's data is validated against its contract schema only when a validator is given, which
// tests do (14 §1.4); it is never logged (14 §1.10).
import { Buffer } from 'node:buffer'
import type {
  HostFrameData,
  HostFrameName,
  HostFrames,
  SubscribeParams,
  SubscribeResult
} from '@dwarfai/contracts'
import { FRAME_ROLES, type ChannelRole } from '../roles'
import { ReplayRing, type RingEntry } from './ring'

/** Who a frame is for: roles within its 14 §2.4 row (all of them by default) and, for a viewer, the dwarf. */
export interface FrameAudience {
  roles?: readonly ChannelRole[]
  dwarfId?: string
}

/** Checks a frame's data against its contract schema (14 §1.4); throws on a mismatch. Tests only. */
export type FrameValidator = (name: string, data: unknown) => void

export type ResyncReason = HostFrames['resync-required']['reason']

/** The frames the transport itself publishes, for `hello.ok.capabilities` (14 §1.3). */
export const TRANSPORT_FRAMES: readonly HostFrameName[] = Object.freeze(['resync-required'])

/**
 * The `causeClass` of `channel.resync` for each reason (19 §9.2 names a new epoch `new-epoch`);
 * the log carries the reason only, never a frame's data.
 */
export const RESYNC_CAUSE_CLASS: Readonly<Record<ResyncReason, string>> = Object.freeze({
  'epoch-changed': 'new-epoch',
  'seq-not-in-ring': 'seq-not-in-ring',
  'ring-overrun': 'ring-overrun',
  backpressure: 'backpressure',
  'metrics-reset': 'metrics-reset'
})

/** One connection as the frame publisher delivers to it. */
export interface DeliveryConnection {
  readonly role: ChannelRole
  readonly clientId: string
  /** `viewer` only: the dwarf it is bound to (ADR-031 item 2). */
  readonly dwarfId?: string
  /** Writes one `evt` frame with `seq`. */
  send<F extends HostFrameName>(name: F, data: HostFrameData[F], seq: number): void
}

export interface SubscribeOutcome {
  result: SubscribeResult
  /** Set when the result is `resync-required`: the reason of the frame that follows. */
  reason?: ResyncReason
  /** Sends the frames that follow the result; the connection runs it once the result is written. */
  release(): void
}

/** One connection target: its seq and, unless it is a notifier, its replay ring. */
class TargetStream<C extends DeliveryConnection> {
  seq = 0
  readonly members = new Set<C>()

  constructor(readonly ring: ReplayRing | null) {}

  next(): number {
    this.seq += 1
    return this.seq
  }
}

interface Delivery<C extends DeliveryConnection> {
  stream: TargetStream<C>
  /** Whether any frame was written to the connection: a later resume cannot be put before it. */
  sentAny: boolean
  /** Frames that wait for a subscribe result to be written, in order; `null` when none waits. */
  held: RingEntry[] | null
}

export class FrameDelivery<C extends DeliveryConnection = DeliveryConnection> {
  private readonly ui = new TargetStream<C>(new ReplayRing())
  private readonly viewers = new Map<string, TargetStream<C>>()
  private readonly notifiers = new Set<TargetStream<C>>()
  private readonly deliveries = new Map<C, Delivery<C>>()

  constructor(private readonly validateFrame?: FrameValidator) {}

  attach(connection: C): void {
    const stream = this.targetOf(connection)
    stream.members.add(connection)
    this.deliveries.set(connection, { stream, sentAny: false, held: null })
  }

  detach(connection: C): void {
    const delivery = this.deliveries.get(connection)
    if (delivery === undefined) return
    delivery.stream.members.delete(connection)
    this.notifiers.delete(delivery.stream)
    this.deliveries.delete(connection)
  }

  /** The connections attached right now, in attach order. */
  connections(): C[] {
    return [...this.deliveries.keys()]
  }

  publishFrame<F extends HostFrameName>(
    name: F,
    data: HostFrameData[F],
    audience: FrameAudience = {}
  ): void {
    this.validateFrame?.(name, data)
    const allowed = FRAME_ROLES[name] ?? []
    const roles =
      audience.roles === undefined
        ? allowed
        : audience.roles.filter((role) => allowed.includes(role))
    if (roles.includes('ui')) this.emit(this.ui, name, data)
    if (roles.includes('viewer') && audience.dwarfId !== undefined) {
      const viewer = this.viewers.get(audience.dwarfId)
      if (viewer !== undefined) this.emit(viewer, name, data)
    }
    if (roles.includes('notifier')) {
      for (const notifier of this.notifiers) this.emit(notifier, name, data)
    }
  }

  /** B-M03 for `connection`, whose target's epoch is `epoch` (14 §3.4). */
  subscribe(connection: C, params: SubscribeParams, epoch: string): SubscribeOutcome {
    const delivery = this.deliveries.get(connection)
    if (delivery === undefined) throw new Error('events.subscribe from a connection not attached')
    const { stream } = delivery
    const resume = params.resume
    if (resume === undefined) {
      return { result: { status: 'live', fromSeq: stream.seq + 1 }, release: () => {} }
    }
    delivery.held ??= []
    const missed =
      resume.epoch === epoch && !delivery.sentAny
        ? (stream.ring?.after(resume.lastSeq, stream.seq) ?? null)
        : null
    if (missed !== null) {
      return {
        result: { status: 'replaying', fromSeq: resume.lastSeq + 1, toSeq: stream.seq },
        release: () => this.release(connection, missed)
      }
    }
    const reason: ResyncReason = resume.epoch === epoch ? 'seq-not-in-ring' : 'epoch-changed'
    const frame = this.entry(stream.next(), 'resync-required', { reason })
    return {
      result: { status: 'resync-required' },
      reason,
      release: () => this.release(connection, [frame])
    }
  }

  /** Sends one `resync-required` to `connection` alone (`backpressure`, after its queue drained). */
  resync(connection: C, reason: ResyncReason): void {
    const delivery = this.deliveries.get(connection)
    if (delivery === undefined) return
    this.deliver(
      connection,
      delivery,
      this.entry(delivery.stream.next(), 'resync-required', { reason })
    )
  }

  private targetOf(connection: C): TargetStream<C> {
    if (connection.role === 'ui') return this.ui
    if (connection.role === 'viewer' && connection.dwarfId !== undefined) {
      const existing = this.viewers.get(connection.dwarfId)
      if (existing !== undefined) return existing
      const created = new TargetStream<C>(new ReplayRing())
      this.viewers.set(connection.dwarfId, created)
      return created
    }
    // A notifier, or a viewer bound to no dwarf: a target of its own that no viewer frame reaches.
    const own = new TargetStream<C>(null)
    if (connection.role === 'notifier') this.notifiers.add(own)
    return own
  }

  private emit(stream: TargetStream<C>, name: string, data: unknown): void {
    const entry: RingEntry = {
      seq: stream.next(),
      name,
      data,
      bytes: stream.ring === null ? 0 : frameBytes(name, data)
    }
    stream.ring?.push(entry)
    for (const connection of stream.members) {
      const delivery = this.deliveries.get(connection)
      if (delivery !== undefined) this.deliver(connection, delivery, entry)
    }
  }

  private entry(
    seq: number,
    name: 'resync-required',
    data: HostFrames['resync-required']
  ): RingEntry {
    this.validateFrame?.(name, data)
    return { seq, name, data, bytes: 0 }
  }

  private deliver(connection: C, delivery: Delivery<C>, entry: RingEntry): void {
    if (delivery.held !== null) {
      delivery.held.push(entry)
      return
    }
    delivery.sentAny = true
    connection.send(entry.name as HostFrameName, entry.data as never, entry.seq)
  }

  /** Writes the frames that follow a subscribe result, then the ones that waited behind them. */
  private release(connection: C, first: readonly RingEntry[]): void {
    const delivery = this.deliveries.get(connection)
    if (delivery === undefined) return
    const waited = delivery.held ?? []
    delivery.held = null
    for (const entry of [...first, ...waited]) this.deliver(connection, delivery, entry)
  }
}

/** A frame's size as the ring counts it: the UTF-8 bytes of its name and JSON data. */
function frameBytes(name: string, data: unknown): number {
  return Buffer.byteLength(name) + Buffer.byteLength(JSON.stringify(data))
}
