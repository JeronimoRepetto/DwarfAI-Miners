// layer: L6
// L6 (17 §1.6): `events.subscribe` (B-M03) and `resync-required` (B-F03) over the real seam-B
// transport — frame codec, hello-first authentication, roles, the Host dispatcher main composes,
// the connection registry, the replay ring and the outbound queue — behind in-process duplexes,
// with every port faked (ADR-003 items 6–8, frozen; 14 §1.7, §1.8, §1.9, §3.4, §3.5; FM-029;
// CH-03). Test frames are published through `publishFrame`, each validated against its contract
// schema (14 §1.4: frames are validated in tests).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  HOST_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema,
  type HostFrameData,
  type HostFrameName
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { acceptConnection } from '../connection'
import { ConnectionRegistry, type AttachedConnection } from '../connectionRegistry'
import { HostStateHolder } from '../lifecycle/hostState'
import { FaultyDuplex } from '../testing/FaultyDuplex'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex, type DuplexPair } from '../testing/inProcessDuplex'
import type { FrameAudience } from './framePublisher'
import { HOST_OUTBOUND_HIGH_WATER } from './outbound'
import { RING_MAX_EVENTS } from './ring'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0025'
const DWARF_A = '0190a6b0-0000-7000-8000-00000000000a'
const DWARF_B = '0190a6b0-0000-7000-8000-00000000000b'

/**
 * The frames these cases publish whose payload types later issues own (each module's wiring
 * routes them, 14 §2.4): their names are the catalog's, their data is this test's. Every other
 * frame is checked against its contract schema.
 */
const TEST_FRAMES = new Set([
  'dwarf.arrived',
  'dwarf.changed',
  'dwarf.departed',
  'conversation.appended',
  'activity.changed',
  'ledger.changed',
  'ask.step'
])

/** 14 §1.4: a frame's data is validated against its schema, in tests only. */
function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema !== undefined) schema.parse(data)
  else if (!TEST_FRAMES.has(name)) throw new Error(`no contract schema for ${name}`)
}

interface Evt {
  seq: number
  epoch: string
  name: string
  data: unknown
}

/** One Host transport: real connections and dispatcher, faked ports. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-025-subscribe-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  // `host.state {ready}` is the ui target's first frame: seq 1 (events.subscribe needs `ready`).
  state.report({ state: 'ready', jobStatus: 'none' })
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle: { closeCleanly: () => Promise.resolve() },
    connections,
    epoch: EPOCH
  })
  const ids = new SequenceIdGenerator()
  const throttle = new HelloThrottle(clock)

  /** Connects with `role` over `pair` and returns the client once hello.ok arrived. */
  const attach = async (
    role: 'ui' | 'notifier',
    pair: DuplexPair = inProcessDuplex()
  ): Promise<FrameClient> => {
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () => [],
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle
    })
    const client = new FrameClient(pair.client)
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }

  /** Publishes one frame by name: the cases use catalog names whose payloads later issues type. */
  const publish = (name: string, data: unknown, audience?: FrameAudience): void =>
    connections.publishFrame(name as HostFrameName, data as never, audience)

  return { log, connections, dispatcher, attach, publish }
}

/** Sends `events.subscribe` and returns its result, checked against the 14 §3.4 schema. */
async function subscribe(client: FrameClient, id: string, params: unknown = {}) {
  client.send({ type: 'req', id, method: 'events.subscribe', params })
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
  const res = resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
  if (!res.ok) return res
  return { ...res, result: HOST_METHOD_SCHEMAS['events.subscribe'].result.parse(res.result) }
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id: string }).id === id
  )
}

/** The evt frames a client received, in arrival order, each validated (envelope and data). */
function evts(client: FrameClient): Evt[] {
  return client.frames
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => {
      const evt = evtFrameSchema.parse(frame)
      validateFrame(evt.name, evt.data)
      return evt
    })
}

/** Every frame after hello.ok, reduced to what the ordering cases compare. */
function wire(client: FrameClient): string[] {
  return client.frames.slice(1).map((frame) => {
    const f = frame as { type: string; id?: string; seq?: number; name?: string }
    return f.type === 'res' ? `res:${f.id}` : `${f.name}#${f.seq}`
  })
}

const tick = (n: number) => ({ n })

describe('events.subscribe and resync-required (ADR-003 items 6–8; 14 §1.7–§1.9, §3.4, §3.5)', () => {
  it('[ADR-003] a fresh subscribe returns live with the next seq and frames carry monotonic seq and the epoch', async () => {
    const h = await host()
    // Frames published before anyone attached are the target's: the next seq follows them.
    h.publish('dwarf.arrived', tick(1))
    h.publish('dwarf.arrived', tick(2))
    const ui = await h.attach('ui')

    const res = await subscribe(ui, 's1')
    expect(res).toMatchObject({ ok: true, result: { status: 'live', fromSeq: 4 } })

    h.publish('dwarf.arrived', tick(3))
    h.publish('dwarf.arrived', tick(4))
    h.publish('dwarf.arrived', tick(5))
    await ui.settle()

    const frames = evts(ui)
    expect(frames.map((frame) => frame.seq)).toEqual([4, 5, 6])
    expect(frames.map((frame) => frame.data)).toEqual([tick(3), tick(4), tick(5)])
    expect(frames.every((frame) => frame.epoch === EPOCH)).toBe(true)
  })

  it('[ADR-003] resume with the same epoch and a lastSeq in the ring returns replaying and the missed frames first', async () => {
    const h = await host()
    const first = await h.attach('ui')
    await subscribe(first, 's1')
    for (let n = 1; n <= 3; n += 1) h.publish('dwarf.arrived', tick(n))
    await first.settle()
    expect(evts(first).map((frame) => frame.seq)).toEqual([2, 3, 4])
    first.stream.destroy()
    await first.settle()

    // Published while no ui is attached: the ring keeps them for the hot reconnect.
    h.publish('dwarf.arrived', tick(4))
    h.publish('dwarf.arrived', tick(5))

    const second = await h.attach('ui')
    const res = await subscribe(second, 's2', { resume: { epoch: EPOCH, lastSeq: 4 } })
    expect(res).toMatchObject({ ok: true, result: { status: 'replaying', fromSeq: 5, toSeq: 6 } })
    h.publish('dwarf.arrived', tick(6))
    await second.settle()

    // The result, then the missed frames in order, then the live ones: no gap and no duplicate.
    expect(wire(second)).toEqual([
      'res:s2',
      'dwarf.arrived#5',
      'dwarf.arrived#6',
      'dwarf.arrived#7'
    ])
    expect(evts(second).map((frame) => frame.data)).toEqual([tick(4), tick(5), tick(6)])
  })

  it('[ADR-003, FM-029] resume with another epoch returns resync-required and a resync-required frame with reason epoch-changed follows', async () => {
    const h = await host()
    h.publish('dwarf.arrived', tick(1))
    const ui = await h.attach('ui')

    const res = await subscribe(ui, 's1', { resume: { epoch: 'epoch-before-restart', lastSeq: 1 } })
    expect(res).toMatchObject({ ok: true, result: { status: 'resync-required' } })
    h.publish('dwarf.arrived', tick(3))
    await ui.settle()

    expect(wire(ui)).toEqual(['res:s1', 'resync-required#3', 'dwarf.arrived#4'])
    expect(evts(ui)[0]?.data).toEqual({ reason: 'epoch-changed' })
    // 19 §9.2: `channel.resync`, the reason only (never a frame's data).
    expect(h.log.byEvent('channel.resync')).toEqual([
      expect.objectContaining({ level: 'info', subsystem: 'transport', causeClass: 'new-epoch' })
    ])
  })

  it('[ADR-003, FM-029] a lastSeq older than the ring returns resync-required with reason seq-not-in-ring', async () => {
    const h = await host()
    const total = RING_MAX_EVENTS + 88
    for (let n = 1; n <= total; n += 1) h.publish('dwarf.arrived', tick(n))
    const ui = await h.attach('ui')

    // seq 1 (host.state) to total + 1; the ring holds the newest 512, so the oldest held is:
    const oldestHeld = total + 1 - RING_MAX_EVENTS + 1
    // The frames after lastSeq 10 are no longer all held.
    const res = await subscribe(ui, 's1', { resume: { epoch: EPOCH, lastSeq: 10 } })
    expect(res).toMatchObject({ ok: true, result: { status: 'resync-required' } })
    await ui.settle()
    expect(wire(ui)).toEqual(['res:s1', `resync-required#${total + 2}`])
    expect(evts(ui)[0]?.data).toEqual({ reason: 'seq-not-in-ring' })

    // One before the oldest held frame is evicted too: refused.
    const evicted = await h.attach('ui')
    const refused = await subscribe(evicted, 's2', {
      resume: { epoch: EPOCH, lastSeq: oldestHeld - 2 }
    })
    expect(refused).toMatchObject({ ok: true, result: { status: 'resync-required' } })

    // The oldest resumable lastSeq is the one just before the oldest held frame; the replay
    // reaches the target's last seq, the resync-required of the others included (not held).
    const later = await h.attach('ui')
    const resumed = await subscribe(later, 's3', {
      resume: { epoch: EPOCH, lastSeq: oldestHeld - 1 }
    })
    expect(resumed).toMatchObject({
      ok: true,
      result: { status: 'replaying', fromSeq: oldestHeld, toSeq: total + 3 }
    })
    await later.settle()
    const replayed = evts(later)
    expect(replayed).toHaveLength(RING_MAX_EVENTS)
    expect(replayed[0]?.seq).toBe(oldestHeld)
    expect(replayed.at(-1)?.seq).toBe(total + 1)
  })

  it('[ADR-003, FM-029, CH-03] a stalled client past 4 MiB of unsent bytes stops receiving frames, then gets one resync-required with reason backpressure when it drains, and the Host loop is never blocked', async () => {
    const h = await host()
    const faults = new FaultyDuplex()
    const stalled = await h.attach('ui', faults)
    const healthy = await h.attach('ui')
    await subscribe(stalled, 's1')
    await subscribe(healthy, 's2')

    faults.stallReads()
    const blob = 'x'.repeat(64 * 1024)
    const count = Math.ceil((HOST_OUTBOUND_HIGH_WATER * 1.25) / blob.length)
    for (let n = 1; n <= count; n += 1) h.publish('dwarf.arrived', { n, blob })
    // Every publish returned at once, and the healthy connection kept receiving meanwhile.
    await healthy.settle()
    expect(evts(healthy).map((frame) => frame.seq)).toEqual(
      Array.from({ length: count }, (_, i) => i + 2)
    )
    expect(stalled.frames.slice(2)).toEqual([])
    // A request answered meanwhile is still answered: only evt frames stop (14 §1.8).
    stalled.send({ type: 'req', id: 'p1', method: 'ping', params: {} })
    await stalled.settle()

    faults.resumeReads()
    await stalled.settle()
    expect(wire(stalled).slice(-2)).toEqual(['res:p1', `resync-required#${count + 2}`])
    const received = evts(stalled)
    const resyncs = received.filter((frame) => frame.name === 'resync-required')
    expect(resyncs).toEqual([
      expect.objectContaining({ seq: count + 2, data: { reason: 'backpressure' } })
    ])
    // It stopped receiving: a prefix of the frames, then the one resync-required, last.
    const before = received.slice(0, -1)
    expect(before.length).toBeLessThan(count)
    expect(before.map((frame) => frame.seq)).toEqual(
      Array.from({ length: before.length }, (_, i) => i + 2)
    )
    expect(received.at(-1)?.name).toBe('resync-required')

    // Drained: frames reach it again, and no second resync-required follows.
    h.publish('dwarf.arrived', tick(-1))
    await stalled.settle()
    expect(
      evts(stalled)
        .slice(-2)
        .map((frame) => frame.name)
    ).toEqual(['resync-required', 'dwarf.arrived'])
    expect(evts(stalled).filter((frame) => frame.name === 'resync-required')).toHaveLength(1)
    expect(h.log.byEvent('channel.resync')).toEqual([
      expect.objectContaining({ level: 'info', causeClass: 'backpressure', role: 'ui' })
    ])
  })

  it('[ADR-003] only dwarf.changed, activity.changed, ledger.changed and ask.step coalesce, keeping the highest seq', async () => {
    const h = await host()
    const faults = new FaultyDuplex()
    const ui = await h.attach('ui', faults)
    await subscribe(ui, 's1')

    // A full socket buffer: the next frames wait in the outbound queue, within one Host tick.
    faults.stallReads()
    h.publish('dwarf.arrived', { n: 1, blob: 'x'.repeat(32 * 1024) })
    h.publish('dwarf.changed', { dwarf: { id: DWARF_A }, n: 2 })
    h.publish('dwarf.changed', { dwarf: { id: DWARF_B }, n: 3 })
    h.publish('dwarf.changed', { dwarf: { id: DWARF_A }, n: 4 })
    h.publish('dwarf.arrived', { dwarf: { id: DWARF_A }, n: 5 })
    h.publish('dwarf.arrived', { dwarf: { id: DWARF_A }, n: 6 })
    h.publish('activity.changed', { dwarfId: DWARF_A, disclosureId: 'd1', n: 7 })
    h.publish('activity.changed', { dwarfId: DWARF_A, disclosureId: 'd1', n: 8 })
    h.publish('ledger.changed', { mineId: 'm1', n: 9 })
    h.publish('ledger.changed', { mineId: 'm1', n: 10 })
    h.publish('ask.step', { askId: 'k1', currentStep: 1 })
    h.publish('ask.step', { askId: 'k1', currentStep: 2 })
    h.publish('dwarf.departed', { dwarfId: DWARF_A, n: 13 })
    h.publish('dwarf.departed', { dwarfId: DWARF_A, n: 14 })
    faults.resumeReads()
    await ui.settle()

    // seq = n + 1 (host.state is seq 1).
    expect(evts(ui).map((frame) => `${frame.name}#${frame.seq}`)).toEqual([
      'dwarf.arrived#2',
      'dwarf.changed#4', // dwarf B: its own key
      'dwarf.changed#5', // dwarf A: #3 folded into it
      'dwarf.arrived#6', // never coalesced
      'dwarf.arrived#7',
      'activity.changed#9',
      'ledger.changed#11',
      'ask.step#13',
      'dwarf.departed#14', // never coalesced
      'dwarf.departed#15'
    ])
    expect(evts(ui).find((frame) => frame.seq === 5)?.data).toEqual({
      dwarf: { id: DWARF_A },
      n: 4
    })
  })

  it('[ADR-003] a notifier calling events.subscribe gets FORBIDDEN', async () => {
    const h = await host()
    const notifier = await h.attach('notifier')

    const res = await subscribe(notifier, 'n1')
    expect(res).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', retryable: false } })
    expect(h.log.byEvent('channel.forbidden')).toEqual([
      expect.objectContaining({ method: 'events.subscribe', role: 'notifier' })
    ])
  })

  it('[ADR-003] a viewer receives only the frames addressed to its bound dwarf', async () => {
    const h = await host()
    const ui = await h.attach('ui')
    await subscribe(ui, 's1')
    // A viewer cannot authenticate yet (AUTH_FAILED until ISSUE-170): one as the registry sees it.
    const viewerA = new FakeViewer('viewer-a', DWARF_A)
    const viewerB = new FakeViewer('viewer-b', DWARF_B)
    h.connections.attach(viewerA)
    h.connections.attach(viewerB)
    for (const viewer of [viewerA, viewerB]) {
      const res = await h.dispatcher.dispatch(
        { id: 'v1', method: 'events.subscribe', params: {} },
        { role: 'viewer', clientId: viewer.clientId }
      )
      expect(res).toEqual({
        type: 'res',
        id: 'v1',
        ok: true,
        result: { status: 'live', fromSeq: 1 }
      })
    }

    h.publish('conversation.appended', { dwarfId: DWARF_A, n: 1 }, { dwarfId: DWARF_A })
    h.publish(
      'activity.changed',
      { dwarfId: DWARF_B, disclosureId: 'd', n: 2 },
      { dwarfId: DWARF_B }
    )
    h.publish('dwarf.changed', { dwarf: { id: DWARF_A }, n: 3 }) // ui only (14 §2.4)
    h.publish('dwarf.departed', { dwarfId: DWARF_A, n: 4 }, { dwarfId: DWARF_A })
    // A viewer frame with no bound dwarf named reaches no viewer.
    h.publish('conversation.appended', { dwarfId: DWARF_A, n: 5 })
    await ui.settle()

    expect(viewerA.frames).toEqual([
      { seq: 1, name: 'conversation.appended', data: { dwarfId: DWARF_A, n: 1 } },
      { seq: 2, name: 'dwarf.departed', data: { dwarfId: DWARF_A, n: 4 } }
    ])
    expect(viewerB.frames).toEqual([
      { seq: 1, name: 'activity.changed', data: { dwarfId: DWARF_B, disclosureId: 'd', n: 2 } }
    ])
    // The ui receives every one of them, on its own seq.
    expect(evts(ui).map((frame) => frame.seq)).toEqual([2, 3, 4, 5, 6])
  })
})

/** A viewer bound to one dwarf, as the registry sees it. */
class FakeViewer implements AttachedConnection {
  readonly role = 'viewer' as const
  readonly frames: Array<{ seq: number; name: string; data: unknown }> = []

  constructor(
    readonly clientId: string,
    readonly dwarfId: string
  ) {}

  send<F extends HostFrameName>(name: F, data: HostFrameData[F], seq: number): void {
    this.frames.push({ seq, name, data })
  }

  end(): Promise<void> {
    return Promise.resolve()
  }
}
