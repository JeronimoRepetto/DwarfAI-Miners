// layer: L10
import { afterEach, describe, expect, it } from 'vitest'
import type { Duplex } from 'node:stream'
import { RecordingUiLog } from '../hostLauncher/fakes/RecordingUiLog'
import type { HostConnection, HostEvent } from '../window/ports/hostClient'
import { createHostClient, type HostClientService } from './HostClient'
import { FakeHost } from './testing/FakeHost'
import { ManualTimers } from './testing/ManualTimers'

// L10 chaos (17 §1.10, CH-01): the Host is killed — a FakeHost crash, its connections dropped and nothing listening —
// while the client attaches or while only the tray process holds a connection, over a faulty transport that kills the
// Host when a chosen connection opens (07 S12.19, S12.B04, S12.B05; ADR-002 D9; 13 FM-006, FM-007).

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/**
 * A faulty transport: the FakeHost's own connect, except that the connection numbered `killAt` (from 1) kills the
 * Host the moment it opens — the client has a socket, the Host is gone before it answers `hello`.
 */
function faultyTransport(host: FakeHost, kill: () => void, killAt: number) {
  let opened = 0
  return async (): Promise<Duplex> => {
    const socket = await host.connect()
    opened += 1
    if (opened === killAt) queueMicrotask(kill)
    return socket
  }
}

/** HostClient whose launcher respawns the FakeHost (a new boot) whenever nothing listens. */
function world(connect: (host: FakeHost, kill: () => void) => () => Promise<Duplex>) {
  const host = new FakeHost()
  const timers = new ManualTimers()
  const log = new RecordingUiLog()
  const launches: number[] = []
  let down = false
  const kill = (): void => {
    down = true
    host.crash()
  }
  const client = createHostClient({
    launcher: {
      ensureHostRunning: () => {
        launches.push(timers.now())
        if (down) {
          host.restart()
          down = false
          return Promise.resolve('spawned')
        }
        return Promise.resolve('attached')
      }
    },
    connect: connect(host, kill),
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers,
    log,
    hungHost: { endHungHost: () => Promise.resolve({ outcome: 'identity-missing' }) }
  })
  clients.push(client)
  const states: HostConnection[] = []
  client.onStateChange((s) => states.push(s))
  const closings: string[] = []
  client.onClosing((reason) => closings.push(reason))
  return { host, timers, log, launches, client, states, closings, kill }
}

describe('a Host killed under the client (CH-01)', () => {
  it('[FM-007] a Host killed during attach is respawned silently while fewer than three crashes happened', async () => {
    // Connection 2 is the `ui` connection of the first attach: the Host dies while the board is being read.
    const w = world((host, kill) => faultyTransport(host, kill, 2))
    const events: HostEvent[] = []
    w.client.subscribe((e) => events.push(e))

    await w.client.ensureHost()
    await settle()
    expect(w.client.state().state).toBe('reconnecting')

    w.timers.advance(250)
    await settle()

    // Respawned through the launcher, attached again with a whole board; never unavailable, no closing.
    expect(w.launches).toHaveLength(2)
    expect(w.client.state()).toEqual({
      state: 'connected',
      hostVersion: '0.0.0-fake',
      compat: false
    })
    expect(w.states.map((s) => s.state)).toEqual(['connected', 'reconnecting', 'connected'])
    expect(events.filter((e) => e.kind === 'snapshot')).toHaveLength(1)
    expect(w.closings).toEqual([])
    // S12.B01, S12.B04, the silent respawn S12.19 (logged, still reconnecting), S12.B05.
    expect(w.log.byEvent('host.connection').map((r) => r.causeClass)).toEqual([
      'connected',
      'reconnecting',
      'reconnecting',
      'connected'
    ])
  })

  it('[FM-006, CH-01, S12.19] a Host killed while only the tray process is attached, with no window open, is respawned at once and nothing is shown', async () => {
    const w = world((host) => host.connect)
    expect(await w.client.ensureHost()).toBe('available')
    await settle()
    expect(w.host.liveConnections('ui')).toBe(0)

    w.kill()
    await settle()
    expect(w.client.state().state).toBe('reconnecting')

    // The first attempt, 250 ms after the loss, finds no endpoint and respawns at once: no further wait.
    w.timers.advance(250)
    await settle()

    expect(w.launches).toEqual([0, 250])
    expect(w.client.state()).toEqual({
      state: 'connected',
      hostVersion: '0.0.0-fake',
      compat: false
    })
    expect(w.host.liveConnections('notifier')).toBe(1)
    // Nothing is shown: no unavailable state, no closing, no snapshot asked for with no window open.
    expect(w.states.map((s) => s.state)).toEqual(['connected', 'reconnecting', 'connected'])
    expect(w.closings).toEqual([])
    expect(w.host.methods('ui')).toEqual([])
  })
})
