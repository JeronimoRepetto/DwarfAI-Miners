// layer: L6
import { afterEach, describe, expect, it } from 'vitest'
import type { EvtFrame, SnapshotChunk } from '@dwarfai/contracts'
import { RecordingUiLog } from '../hostLauncher/fakes/RecordingUiLog'
import type { EnsureHostResult } from '../hostLauncher/launcher'
import type { HostEvent } from '../window/ports/hostClient'
import { deadlineOf, HOST_ASK_HANDOVER_MS } from './deadlines'
import { createHostClient, HostCallError, type HostClientService } from './HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from './testing/FakeHost'
import { ManualTimers } from './testing/ManualTimers'

// L6 (17 §1.6; 16 §4.14.1): the real HostClient against FakeHost, the in-process fake Host speaking the seam-B
// frames over in-memory duplex pairs (ADR-003 items 4–9, 12; 14 §1.3, §1.6, §1.9, §3.10, §4.2, §4.3; 07 S12.B01,
// S12.B05, S12.B08). TC-051-01, TC-051-02, TC-051-03.

const R1 = '01890a5d-ac96-774b-bcce-b302099a8001'
const R2 = '01890a5d-ac96-774b-bcce-b302099a8002'
const R3 = '01890a5d-ac96-774b-bcce-b302099a8003'

const meta: SnapshotChunk = {
  section: 'meta',
  data: {
    hostVersion: '0.0.0-fake',
    state: 'ready',
    resetEpoch: 0,
    snapshotTail: 20,
    minesEverKnown: true
  }
}
/** A dwarf as the board carries it; the client never reads a chunk's data. */
const dwarfs = (...ids: string[]): SnapshotChunk => ({
  section: 'dwarfs',
  data: ids.map((id) => ({ id })) as never
})
const mineNames: SnapshotChunk = { section: 'mine-names', data: [] }

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

/** Lets the in-memory pipes and the promises behind them settle. */
async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/** Lets `ms` pass one second at a time, the pipes settling in between (pings and their answers flow). */
async function elapse(timers: ManualTimers, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= Math.min(1_000, left)) {
    timers.advance(Math.min(1_000, left))
    await settle()
  }
}

function world(
  options: { capabilities?: readonly string[]; launcher?: () => Promise<EnsureHostResult> } = {}
) {
  const host = new FakeHost({ capabilities: options.capabilities ?? FAKE_HOST_CAPABILITIES })
  const timers = new ManualTimers()
  const log = new RecordingUiLog()
  const launches: unknown[][] = []
  const client = createHostClient({
    launcher: {
      ensureHostRunning: (...args: unknown[]) => {
        launches.push(args)
        return options.launcher?.() ?? Promise.resolve('attached')
      }
    },
    connect: host.connect,
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers,
    log
  })
  clients.push(client)
  const events: HostEvent[] = []
  return { host, timers, log, launches, client, events, handler: (e: HostEvent) => events.push(e) }
}

/** Calls a method the cut-0 catalog does not hold yet (its entry lands with its issue, 14 §3.4). */
function callLater(client: HostClientService, method: string, params: unknown): Promise<unknown> {
  return client.call(method as never, params as never)
}

const frameNames = (events: HostEvent[]): string[] =>
  events
    .filter((e): e is { kind: 'frame'; frame: EvtFrame } => e.kind === 'frame')
    .map((e) => e.frame.name as string)
const snapshots = (events: HostEvent[]) => events.filter((e) => e.kind === 'snapshot')
const frameSeqs = (events: HostEvent[]): number[] =>
  events.flatMap((e) => (e.kind === 'frame' ? [e.frame.seq] : []))

describe('HostClient against FakeHost (16 §4.14.1)', () => {
  it('[ADR-003, S12.B01] the client subscribes before it reads the snapshot and applies only frames with seq greater than the snapshot seq', async () => {
    const { host, client, events, handler } = world()
    host.board = [meta, mineNames, dwarfs('d1')]
    host.pageSize = 1
    let early = 0
    let late = 0
    host.afterSubscribe = () => {
      early = host.publish('dwarf.changed', { dwarf: { id: 'early' } })
    }
    host.beforePage = (index) => {
      if (index === 1) late = host.publish('dwarf.changed', { dwarf: { id: 'late' } })
    }

    client.subscribe(handler)
    expect(await client.ensureHost()).toBe('available')
    await settle()

    expect(host.hellos.map((h) => h.role)).toEqual(['notifier', 'ui'])
    const ui = host.received.filter((r) => r.role === 'ui')
    expect(ui.map((r) => r.method)).toEqual([
      'events.subscribe',
      'session.snapshot',
      'session.snapshot',
      'session.snapshot'
    ])
    const [, first, ...rest] = ui.map(
      (r) => r.params as { snapshotId?: string; sections?: string[] }
    )
    expect(first?.sections).toEqual(['meta'])
    expect(new Set(rest.map((p) => p.snapshotId)).size).toBe(1)

    const snapshot = snapshots(events)
    expect(snapshot).toHaveLength(1)
    const s = snapshot[0] as {
      kind: 'snapshot'
      snapshot: { seq: number; chunks: SnapshotChunk[]; next?: string }
    }
    expect(s.snapshot.chunks).toEqual([meta, mineNames, dwarfs('d1')])
    expect(s.snapshot.next).toBeUndefined()
    expect(early).toBeLessThanOrEqual(s.snapshot.seq)
    expect(late).toBeGreaterThan(s.snapshot.seq)
    expect(events.map((e) => (e.kind === 'frame' ? e.frame.seq : 'snapshot'))).toEqual([
      'snapshot',
      late
    ])
  })

  it('[ADR-003, S12.B01] a Host still starting is waited for: the client subscribes once host.state reports it ready', async () => {
    const { host, client, events, handler } = world()
    host.state = 'starting'
    client.subscribe(handler)
    await client.ensureHost()
    await settle()
    expect(snapshots(events)).toHaveLength(0)

    host.state = 'ready'
    host.publish('host.state', { state: 'ready', jobStatus: 'n/a' })
    await settle()

    expect(host.methods('ui').filter((m) => m === 'events.subscribe').length).toBeGreaterThan(0)
    expect(host.methods('ui').at(-1)).toBe('session.snapshot')
    expect(snapshots(events)).toHaveLength(1)
  })

  it('[ADR-003] a handler that subscribes while attached starts from a whole snapshot, then the frames after it', async () => {
    const { host, client, handler } = world()
    host.board = [meta, dwarfs('d1')]
    client.subscribe(handler)
    await client.ensureHost()
    await settle()

    const later: HostEvent[] = []
    client.subscribe((e) => later.push(e))
    await settle()
    const seq = host.publish('dwarf.changed', { dwarf: { id: 'd1' } })
    await settle()

    expect(later.map((e) => (e.kind === 'frame' ? e.frame.seq : 'snapshot'))).toEqual([
      'snapshot',
      seq
    ])
    expect(host.liveConnections('ui')).toBe(1)
  })

  it('[ADR-003, S12.B08] resync-required makes the client re-snapshot and no dwarf missing from the new snapshot walks out', async () => {
    const { host, client, events, handler } = world()
    host.board = [meta, dwarfs('d1', 'd2')]
    client.subscribe(handler)
    await client.ensureHost()
    await settle()
    expect(snapshots(events)).toHaveLength(1)

    host.board = [meta, dwarfs('d1')]
    host.publish('resync-required', { reason: 'ring-overrun' })
    await settle()

    const all = snapshots(events) as Array<{ snapshot: { chunks: SnapshotChunk[] } }>
    expect(all).toHaveLength(2)
    expect(all[1]?.snapshot.chunks).toEqual([meta, dwarfs('d1')])
    expect(frameNames(events)).toEqual([])
    expect(host.methods('ui').filter((m) => m === 'session.snapshot')).toHaveLength(4)
  })

  it('[ADR-003] a method absent from capabilities is refused locally with NOT_SUPPORTED and no frame is sent', async () => {
    const { host, client, handler } = world({
      capabilities: FAKE_HOST_CAPABILITIES.filter((name) => name !== 'host.upgrade.request')
    })
    client.subscribe(handler)
    await client.ensureHost()
    await settle()
    const before = host.received.length

    const refused = client
      .call('host.upgrade.request', { targetVersion: '9.9.9', targetDir: 'x', requestId: R1 })
      .catch((error: unknown) => error)
    const error = await refused
    await settle()

    expect(error).toBeInstanceOf(HostCallError)
    expect((error as HostCallError).error.code).toBe('NOT_SUPPORTED')
    expect(host.received.length).toBe(before)
    expect(client.capabilities()).not.toContain('host.upgrade.request')
  })

  it('[ADR-003] SNAPSHOT_EXPIRED on a later page restarts the snapshot from the first page', async () => {
    const { host, client, events, handler } = world()
    host.board = [meta, mineNames, dwarfs('d1')]
    host.beforePage = (index) => {
      if (index === 0 && host.methods('ui').filter((m) => m === 'session.snapshot').length === 1) {
        host.expireNextContinuation = true
      }
    }
    client.subscribe(handler)
    await client.ensureHost()
    await settle()

    const pages = host.received
      .filter((r) => r.method === 'session.snapshot')
      .map((r) => r.params as { snapshotId?: string; cursor?: string })
    expect(pages.map((p) => (p.snapshotId === undefined ? 'first' : 'next'))).toEqual([
      'first',
      'next',
      'first',
      'next',
      'next'
    ])
    const all = snapshots(events) as Array<{ snapshot: { chunks: SnapshotChunk[] } }>
    expect(all).toHaveLength(1)
    expect(all[0]?.snapshot.chunks).toEqual([meta, mineNames, dwarfs('d1')])
  })

  it('[ADR-003] after a new epoch only conversation.send and asking.answer are re-sent, with the same requestId', async () => {
    const { host, timers, client, events, handler } = world({
      capabilities: [
        ...FAKE_HOST_CAPABILITIES,
        'conversation.send',
        'asking.answerQuestion',
        'crew.stop'
      ]
    })
    const never = () => new Promise(() => {})
    host.handle('conversation.send', never)
    host.handle('asking.answerQuestion', never)
    host.handle('crew.stop', never)
    client.subscribe(handler)
    await client.ensureHost()
    await settle()

    const send = callLater(client, 'conversation.send', {
      dwarfId: 'd1',
      text: 'hi',
      requestId: R1
    })
    const answer = callLater(client, 'asking.answerQuestion', { askId: 'a1', requestId: R2 })
    const stop = callLater(client, 'crew.stop', { dwarfId: 'd1', requestId: R3 }).catch(
      (e: unknown) => e
    )
    await settle()

    host.crash()
    host.restart('epoch-2')
    host.handle('conversation.send', () => ({ messageId: 'm1' }))
    host.handle('asking.answerQuestion', () => ({ outcome: 'answered' }))
    await settle()
    expect(client.state().state).toBe('reconnecting')
    timers.advance(250)
    await settle()

    expect(client.state()).toEqual({ state: 'connected', hostVersion: '0.0.0-fake', compat: false })
    const resent = host.received.filter((r) => r.epoch === 'epoch-2' && r.role === 'ui')
    const mutations = resent.filter(
      (r) => !['events.subscribe', 'session.snapshot'].includes(r.method)
    )
    expect(mutations.map((r) => [r.method, (r.params as { requestId: string }).requestId])).toEqual(
      [
        ['conversation.send', R1],
        ['asking.answerQuestion', R2]
      ]
    )
    expect(await send).toEqual({ messageId: 'm1' })
    expect(await answer).toEqual({ outcome: 'answered' })
    const refused = (await stop) as HostCallError
    expect(refused.error).toMatchObject({ code: 'HOST_UNAVAILABLE', retryable: true })
    // 14 §4.3 rule 3: a new epoch is always a fresh snapshot, never a replay.
    expect(resent[0]).toMatchObject({ method: 'events.subscribe', params: {} })
    expect(snapshots(events)).toHaveLength(2)
  })

  it('[ADR-003, S12.B05] after a hot reconnect every in-flight mutation is re-sent once with its requestId and only the missed frames are applied', async () => {
    const { host, timers, client, events, handler } = world({
      capabilities: [...FAKE_HOST_CAPABILITIES, 'crew.stop']
    })
    let stops = 0
    host.handle('crew.stop', () => {
      stops += 1
      return stops === 1 ? new Promise(() => {}) : { outcome: 'stopped' }
    })
    client.subscribe(handler)
    await client.ensureHost()
    await settle()
    const applied = host.publish('dwarf.changed', { dwarf: { id: 'd1' } })
    await settle()

    const stop = callLater(client, 'crew.stop', { dwarfId: 'd1', requestId: R3 })
    await settle()
    host.dropConnections()
    await settle()
    const missed = host.publish('dwarf.changed', { dwarf: { id: 'd2' } })
    timers.advance(250)
    await settle()

    expect(host.hellos.filter((h) => h.role === 'ui')).toHaveLength(2)
    const subscribe = host.received.filter((r) => r.method === 'events.subscribe').at(-1)
    expect(subscribe?.params).toEqual({ resume: { epoch: 'epoch-1', lastSeq: applied } })
    expect(host.received.filter((r) => r.method === 'crew.stop').map((r) => r.params)).toEqual([
      { dwarfId: 'd1', requestId: R3 },
      { dwarfId: 'd1', requestId: R3 }
    ])
    expect(await stop).toEqual({ outcome: 'stopped' })
    expect(snapshots(events)).toHaveLength(1)
    expect(
      events.filter((e) => e.kind === 'frame').map((e) => (e as { frame: EvtFrame }).frame.seq)
    ).toEqual([applied, missed])
  })

  it('[ADR-003, S12.B05] after a resume no frame is applied twice and none past a gap the Host did not replay', async () => {
    const { host, timers, client, events, handler } = world()
    client.subscribe(handler)
    await client.ensureHost()
    await settle()
    const a = host.publish('dwarf.changed', { dwarf: { id: 'a' } })
    await settle()

    // A replay that repeats the frame already applied: it is applied once.
    host.replayOverlap = 1
    host.dropConnections()
    await settle()
    const b = host.publish('dwarf.changed', { dwarf: { id: 'b' } })
    timers.advance(250)
    await settle()
    expect(frameSeqs(events)).toEqual([a, b])

    // A resume the ring no longer covers: the frames past the gap are not applied, a whole snapshot is read instead.
    host.replayOverlap = 0
    host.dropConnections()
    await settle()
    host.publish('dwarf.changed', { dwarf: { id: 'c' } })
    const d = host.publish('dwarf.changed', { dwarf: { id: 'd' } })
    host.forgetThrough(d - 1)
    timers.advance(250)
    await settle()
    expect(frameSeqs(events)).toEqual([a, b])
    const last = snapshots(events).at(-1) as { snapshot: { seq: number } }
    expect(snapshots(events)).toHaveLength(2)
    expect(last.snapshot.seq).toBeGreaterThanOrEqual(d)
  })

  it('[ADR-003] the notifier connection never sends a mutating method', async () => {
    const { host, timers, client, handler } = world()
    await client.ensureHost()
    await settle()

    // No window: no ui connection, and the notifier carries no mutation.
    const refused = await client
      .call('host.shutdown', { mode: 'stop-all', requestId: R1 })
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(HostCallError)
    expect((refused as HostCallError).error.code).toBe('HOST_UNAVAILABLE')

    const unsubscribe = client.subscribe(handler)
    await settle()
    await client.call('host.shutdown', { mode: 'stop-all', requestId: R2 })
    unsubscribe()
    timers.advance(5_000)
    await settle()

    const notifier = host.received.filter((r) => r.role === 'notifier')
    expect(notifier.map((r) => r.method)).toEqual(['ping'])
    expect(
      notifier.some((r) => typeof (r.params as { requestId?: unknown }).requestId === 'string')
    ).toBe(false)
    expect(host.received.filter((r) => r.method === 'host.shutdown').map((r) => r.role)).toEqual([
      'ui'
    ])
  })

  it("[FM-032] a call past its per-method deadline answers TIMEOUT as retryable and the client does not re-send it, and the asking.answer deadline of 45 s exceeds the Host's 30 s hand-over", async () => {
    const { host, timers, client, handler } = world({
      capabilities: [...FAKE_HOST_CAPABILITIES, 'crew.stop']
    })
    host.handle('crew.stop', () => new Promise(() => {}))
    client.subscribe(handler)
    await client.ensureHost()
    await settle()

    const stop = callLater(client, 'crew.stop', { dwarfId: 'd1', requestId: R3 }).catch(
      (e: unknown) => e
    )
    await settle()
    await elapse(timers, 59_999)
    expect(host.received.filter((r) => r.method === 'crew.stop')).toHaveLength(1)
    timers.advance(1)
    const timedOut = (await stop) as HostCallError
    expect(timedOut.error).toMatchObject({ code: 'TIMEOUT', retryable: true })

    host.dropConnections()
    await settle()
    timers.advance(250)
    await settle()
    expect(client.state().state).toBe('connected')
    expect(host.received.filter((r) => r.method === 'crew.stop')).toHaveLength(1)

    expect(deadlineOf('asking.answerQuestion', {})).toBe(45_000)
    expect(deadlineOf('asking.answerPermission', {})).toBe(45_000)
    expect(deadlineOf('asking.answerQuestion', {})).toBeGreaterThan(HOST_ASK_HANDOVER_MS)
  })

  it('[ADR-003] the uiToken goes only into hello: never into a log record, a request, the launcher or the environment', async () => {
    const { host, log, launches, client, handler } = world({
      capabilities: [...FAKE_HOST_CAPABILITIES, 'crew.stop']
    })
    client.subscribe(handler)
    await client.ensureHost()
    await settle()
    await callLater(client, 'crew.stop', { dwarfId: 'd1', requestId: R3 })
    host.crash()
    await settle()

    expect(host.hellos.map((h) => h.token)).toEqual([host.token, host.token])
    expect(log.entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(log.entries)).not.toContain(host.token)
    expect(JSON.stringify(host.received)).not.toContain(host.token)
    expect(JSON.stringify(launches)).not.toContain(host.token)
    expect(Object.values(process.env).some((value) => value?.includes(host.token) === true)).toBe(
      false
    )
  })

  it('[ADR-003] withUiConnection with no window open runs the work on a short-lived ui connection and closes it after', async () => {
    const { host, client } = world()
    await client.ensureHost()
    await settle()
    expect(host.liveConnections('ui')).toBe(0)

    const outcome = await client.withUiConnection(async (c) => {
      expect(host.liveConnections('ui')).toBe(1)
      return c.call('host.shutdown', { mode: 'stop-all', requestId: R1 })
    })
    await settle()

    expect(outcome).toEqual({})
    expect(host.liveConnections('ui')).toBe(0)
    expect(host.received.filter((r) => r.method === 'host.shutdown').map((r) => r.role)).toEqual([
      'ui'
    ])
  })

  it('[ADR-003] host.closing on the notifier connection ends the link without a reconnect attempt', async () => {
    const { host, timers, client, launches } = world()
    const closings: string[] = []
    client.onClosing((reason) => closings.push(reason))
    await client.ensureHost()
    await settle()

    host.closeCleanly('stop-all')
    await settle()
    timers.advance(10_000)
    await settle()

    expect(closings).toEqual(['stop-all'])
    expect(launches).toHaveLength(1)
    expect(host.hellos).toHaveLength(1)
  })
})
