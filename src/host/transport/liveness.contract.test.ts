// layer: L6
// L6 (17 §1.6): `ping` and the Host side of liveness over the real seam-B transport, behind the CH-03
// fault wrapper (17 §1.10), on a FakeClock and FakeScheduler (ADR-003 item 9, AMENDMENT-10; 14 B-M02;
// 16 §2.6). The Host sends no ping: a connection closed, or with no frame for 15 s, is a detached
// client, and no session, ask or dwarf changes (ADR-002 D1).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_METHOD_SCHEMAS, PROTOCOL_VERSION, resFrameSchema } from '@dwarfai/contracts'
import type { DomainEvent } from '../kernel/domain/domainEvent'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import { UI_TOKEN_FILE, UiToken } from './auth/uiToken'
import { collectCapabilities } from './capabilities'
import { acceptConnection } from './connection'
import { ConnectionRegistry } from './connectionRegistry'
import { Dispatcher } from './dispatcher'
import { HostStateHolder } from './lifecycle/hostState'
import { SILENCE_MS } from './liveness'
import { registerPing } from './methods/ping'
import { FaultyDuplex } from './testing/FaultyDuplex'
import { FrameClient } from './testing/frameClient'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const IDENTITY = { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION }

/** One Host boot with only the transport's own method served. */
async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-024-liveness-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'run')
  const token = new UiToken()
  await token.issue(dir)
  const clock = new FakeClock(1_000)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const dispatcher = new Dispatcher({ log, clock, scheduler, state: () => state.current().state })
  registerPing(dispatcher, clock)
  const ids = new SequenceIdGenerator()

  /** Opens one connection through the fault wrapper; returns the wrapper and its test client. */
  const connect = (): { faults: FaultyDuplex; client: FrameClient } => {
    const faults = new FaultyDuplex()
    acceptConnection(faults.host, {
      token,
      ids,
      identity: IDENTITY,
      epoch: 'epoch-0001',
      state: () => state.current(),
      capabilities: () => collectCapabilities({ methods: dispatcher.methods() }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections
    })
    return { faults, client: new FrameClient(faults.client) }
  }

  /** Connects and authenticates with `role`. */
  const authenticated = async (role: string) => {
    const connection = connect()
    connection.client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: readFileSync(join(dir, UI_TOKEN_FILE), 'utf8'),
      client: { appVersion: '0.20.0', buildId: 'abc1234', pid: 4242 }
    })
    await connection.client.settle()
    expect(connection.client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return connection
  }

  return { clock, scheduler, log, connections, dispatcher, authenticated }
}

/** Sends one req and returns its validated res. */
async function call(client: FrameClient, id: string, method: string, params: unknown) {
  const before = client.frames.length
  client.send({ type: 'req', id, method, params })
  await client.settle()
  expect(client.frames.length).toBe(before + 1)
  return resFrameSchema.parse(client.frames[before])
}

describe('ping (14 B-M02, ADR-003 item 9)', () => {
  it('[ADR-003] ping from a ui, notifier or viewer connection returns the Host time', async () => {
    const host = await boot()
    // A viewer cannot authenticate before ADR-031 lands (hello.ts): its scope is the roles table's.
    for (const role of ['ui', 'notifier']) {
      const { client } = await host.authenticated(role)
      host.clock.advance(250)
      const res = await call(client, 'p1', 'ping', {})
      expect(res, role).toEqual({
        type: 'res',
        id: 'p1',
        ok: true,
        result: { at: host.clock.now() }
      })
      expect(HOST_METHOD_SCHEMAS.ping.result.safeParse(res.ok && res.result).success).toBe(true)
    }
    // The viewer's scope, through the same dispatcher a viewer connection's requests reach.
    const viewer = await host.dispatcher.dispatch(
      { id: 'p2', method: 'ping', params: {} },
      { role: 'viewer', clientId: 'viewer-1' }
    )
    expect(viewer).toEqual({ type: 'res', id: 'p2', ok: true, result: { at: host.clock.now() } })
  })
})

describe('Host-side liveness (ADR-003 item 9, AMENDMENT-10; 16 §2.6)', () => {
  it('[ADR-003, FM-028, CH-03] a connection silent for 15 s is closed as detached and no session-affecting event is published', async () => {
    const host = await boot()
    // The transport takes no event bus: a detach can publish nothing. The bus records that it did not.
    const bus = new RecordingEventBus<DomainEvent<string, unknown>>()
    const { faults, client } = await host.authenticated('ui')
    // The peer is suspended: its ping never reaches the Host.
    faults.stall()
    client.send({ type: 'req', id: 'p1', method: 'ping', params: {} })

    host.clock.advance(SILENCE_MS - 1)
    await client.settle()
    expect(client.closed).toBe(false)
    expect(host.connections.connections()).toHaveLength(1)

    host.clock.advance(1)
    await client.settle()
    expect(client.closed).toBe(true)
    // Closed without a frame: protocol error frames exist only before hello.ok (14 §1.5).
    expect(client.frames).toHaveLength(1)
    expect(host.connections.connections()).toHaveLength(0)
    expect(host.log.byEvent('channel.detach')).toEqual([
      {
        level: 'info',
        event: 'channel.detach',
        subsystem: 'transport',
        role: 'ui',
        connId: expect.any(String),
        causeClass: 'silent'
      }
    ])
    expect(bus.published).toEqual([])
    expect(host.scheduler.nextDueAt()).toBeNull()
  })

  it('[ADR-003, CH-03] a connection that stalls for 14 s and then sends a frame stays open', async () => {
    const host = await boot()
    const { faults, client } = await host.authenticated('notifier')
    faults.stall()
    client.send({ type: 'req', id: 'p1', method: 'ping', params: {} })
    host.clock.advance(14_000)

    // The held frame arrives three bytes at a time; only the whole frame counts.
    faults.splitInto(3)
    faults.resume()
    await client.settle()
    expect(client.frames[1]).toEqual({
      type: 'res',
      id: 'p1',
      ok: true,
      result: { at: host.clock.now() }
    })

    // The silence is counted again from that frame, not from hello.ok.
    host.clock.advance(SILENCE_MS - 1)
    await client.settle()
    expect(client.closed).toBe(false)
    host.clock.advance(1)
    await client.settle()
    expect(client.closed).toBe(true)
    expect(host.log.byEvent('channel.detach')).toMatchObject([
      { role: 'notifier', causeClass: 'silent' }
    ])
  })

  it('[ADR-003] a closed connection is removed and logged channel.detach; the Host keeps running', async () => {
    const host = await boot()
    const { faults, client } = await host.authenticated('ui')
    faults.close()
    await client.settle()

    expect(host.connections.connections()).toHaveLength(0)
    expect(host.log.byEvent('channel.detach')).toEqual([
      {
        level: 'info',
        event: 'channel.detach',
        subsystem: 'transport',
        role: 'ui',
        connId: expect.any(String)
      }
    ])
    // Its silence timer went with it.
    expect(host.scheduler.nextDueAt()).toBeNull()

    // The Host still serves the next client.
    const next = await host.authenticated('ui')
    expect(await call(next.client, 'p1', 'ping', {})).toMatchObject({ ok: true })
    expect(host.connections.connections()).toHaveLength(1)
  })
})
