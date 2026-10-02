// layer: L6
import { duplexPair, type Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  CHANNELS,
  hostConnectionViewSchema,
  UNROUTED,
  type ChannelSpec,
  type HostConnectionView
} from '@dwarfai/contracts'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import type { HungHostEnd } from '../../hostLauncher/hungHost'
import type { EnsureHostResult } from '../../hostLauncher/launcher'
import {
  createHostClient,
  HostCallError,
  type HostClientService
} from '../../host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from '../../host-client/testing/FakeHost'
import { FakeHostClientTimers } from '../../host-client/testing/FakeHostClientTimers'
import type { HostEvent } from '../../window/ports/hostClient'
import { createRouter, type RouteTarget } from '../router'
import { ROUTES } from '../routes'
import type { IpcSenderEvent, SenderPolicy } from '../senderCheck'
import { createHostConnectionRows, pushHostConnection } from './hostConnection'

// L6 (17 §1.6): A-N03 `getHostConnection`, A-N04 `onHostConnection`, A-N05 `retryHostConnection` (14 §2.2, §3.8;
// ADR-002 D9) over the real HostClient against FakeHost, and A-N33 `confirmHostRestart` (AMENDMENT-11) as the registry
// and the router hold it. TC-052-02, TC-052-03, TC-052-05.

const R1 = '01890a5d-ac96-774b-bcce-b302099a8101'
const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id === PANEL_ID }
const fromPanel: IpcSenderEvent = { sender: { id: PANEL_ID }, senderFrame: { url: APP_ENTRY } }

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

/** Lets the in-memory pipes and the promises behind them settle. */
async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/** Lets `ms` pass in steps of at most 250 ms, the pipes settling in between. */
async function elapse(timers: FakeHostClientTimers, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= Math.min(250, left)) {
    timers.advance(Math.min(250, left))
    await settle()
  }
}

/** A faulty transport: something accepts the connection and never answers (a hung Host holding its endpoint). */
function hungConnection(): Duplex {
  const [client, server] = duplexPair()
  server.on('data', () => {})
  server.on('error', () => {})
  client.on('error', () => {})
  client.once('close', () => server.destroy())
  return client
}

/**
 * HostClient over FakeHost; the launcher's answer after the first attach is `respawn` (default: the Host stays down);
 * `transport.hung` makes every new connection a hung one; `ender` is the launcher's identity-checked end.
 */
function world() {
  const host = new FakeHost({ capabilities: [...FAKE_HOST_CAPABILITIES, 'conversation.send'] })
  const timers = new FakeHostClientTimers()
  let launches = 0
  const respawn: { next: () => EnsureHostResult } = {
    next: () => ({ unavailable: 'spawn-failed' })
  }
  const transport = { hung: false }
  const ender = { calls: 0, next: (): HungHostEnd => ({ outcome: 'identity-missing' }) }
  const log = new RecordingUiLog()
  const client = createHostClient({
    launcher: {
      ensureHostRunning: () => {
        launches += 1
        return Promise.resolve(launches === 1 ? 'attached' : respawn.next())
      }
    },
    connect: () => (transport.hung ? Promise.resolve(hungConnection()) : host.connect()),
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers,
    log,
    hungHost: {
      endHungHost: () => {
        ender.calls += 1
        return Promise.resolve(ender.next())
      }
    }
  })
  clients.push(client)
  const pushes: HostConnectionView[] = []
  pushHostConnection(client, (view) => pushes.push(view))
  return {
    host,
    timers,
    client,
    pushes,
    respawn,
    transport,
    ender,
    log,
    launches: () => launches,
    rows: createHostConnectionRows(client)
  }
}

/** Connected, then the Host dies and every respawn fails until three crashes fell within 5 minutes. */
async function crashLoop(w: ReturnType<typeof world>): Promise<void> {
  expect(await w.client.ensureHost()).toBe('available')
  await settle()
  w.host.crash()
  await settle()
  await elapse(w.timers, 2_000)
}

describe('A-N03…A-N05 Host connection rows (14 §2.2; ADR-002 D9)', () => {
  it('[FM-146] a mutation while reconnecting answers HOST_UNAVAILABLE and nothing is sent', async () => {
    const w = world()
    const events: HostEvent[] = []
    w.client.subscribe((e) => events.push(e))
    expect(await w.client.ensureHost()).toBe('available')
    await settle()
    expect(events.filter((e) => e.kind === 'snapshot')).toHaveLength(1)

    w.host.crash()
    await settle()

    const view = (await w.rows.serve('host:connection:get', undefined)) as HostConnectionView
    expect(view).toEqual({ state: 'reconnecting', since: 0 })
    const sent = w.client.call('conversation.send' as never, { requestId: R1, text: 'hi' } as never)
    await expect(sent).rejects.toBeInstanceOf(HostCallError)
    await expect(sent).rejects.toMatchObject({
      error: { code: 'HOST_UNAVAILABLE', retryable: true }
    })
    expect(w.host.methods()).not.toContain('conversation.send')
    // The last snapshot stays: nothing replaced or cleared the board the handlers hold.
    expect(events.filter((e) => e.kind === 'snapshot')).toHaveLength(1)
  })

  it('[ADR-002] onHostConnection pushes every state change with its reason and capabilities', async () => {
    const w = world()
    let answered: unknown = 'pending'

    expect(await w.client.ensureHost()).toBe('available')
    await settle()
    w.host.crash()
    await settle()
    // A caller that waits for the Host while it reconnects gets the outcome, whatever it is.
    void w.client.ensureHost().then((availability) => (answered = availability))
    await elapse(w.timers, 2_000)
    expect(answered).toEqual({ unavailable: 'crash-loop' })

    expect(w.pushes).toEqual([
      {
        state: 'connected',
        hostVersion: '0.0.0-fake',
        compat: false,
        hostState: 'ready',
        jobStatus: 'n/a',
        capabilities: [...FAKE_HOST_CAPABILITIES, 'conversation.send']
      },
      { state: 'reconnecting', since: 0 },
      { state: 'unavailable', reason: 'crash-loop' }
    ])
    for (const view of w.pushes) expect(hostConnectionViewSchema.safeParse(view).success).toBe(true)
    // Respawning stopped: no launcher call after the third crash, however long the window waits.
    const launches = w.launches()
    await elapse(w.timers, 60_000)
    expect(w.launches()).toBe(launches)
    expect(w.pushes.at(-1)).toEqual({ state: 'unavailable', reason: 'crash-loop' })
  })

  it('[ADR-002] retryHostConnection while crash-loop starts a new attach through the launcher', async () => {
    const w = world()
    await crashLoop(w)
    const launches = w.launches()
    w.respawn.next = () => {
      w.host.restart()
      return 'spawned'
    }

    const answer = (await w.rows.serve('host:connection:retry', undefined)) as HostConnectionView

    expect(answer).toEqual({ state: 'connecting' })
    await settle()
    expect(w.launches()).toBe(launches + 1)
    expect(w.client.state()).toEqual({
      state: 'connected',
      hostVersion: '0.0.0-fake',
      compat: false
    })
    expect(w.pushes.slice(-2).map((v) => v.state)).toEqual(['connecting', 'connected'])
  })

  it('[ADR-001] A-N33 confirmHostRestart is declared with its schema, listed unrouted until generation-2, and a call to it is refused like a channel with no route', async () => {
    const registry = CHANNELS as Readonly<
      Record<string, ChannelSpec<z.ZodTypeAny, z.ZodTypeAny> | undefined>
    >
    const row = registry['host:connection:confirm-restart']
    expect(row).toMatchObject({
      name: 'host:connection:confirm-restart',
      kind: 'invoke',
      placement: 'ui-local',
      status: 'new'
    })
    expect(row?.response).toBe(hostConnectionViewSchema)
    expect(UNROUTED['host:connection:confirm-restart']).toBe('generation-2')

    const w = world()
    const legacy: string[] = []
    const router = createRouter({
      routes: ROUTES,
      legacy: {
        serve: (channel) => {
          legacy.push(channel)
          return Promise.resolve(undefined)
        }
      } satisfies RouteTarget,
      uiLocal: w.rows,
      // AMENDED for ISSUE-056 (was: no host target): the cut-0 table routes A-N26 `host`, so the router needs one.
      host: { serve: () => Promise.resolve(undefined) },
      senders
    })
    const noRoute = {
      ok: false,
      error: {
        code: 'METHOD_NOT_FOUND',
        message: 'no route for host:connection:confirm-restart',
        retryable: false
      }
    }
    expect(await router.dispatch('host:connection:confirm-restart', fromPanel, undefined)).toEqual(
      noRoute
    )
    // Even reached directly, the Host connection rows serve only their own channels.
    expect(await w.rows.serve('host:connection:confirm-restart', undefined)).toMatchObject({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', retryable: false }
    })
    expect(legacy).toEqual([])
    expect(w.host.methods()).toEqual([])
  })

  it('[S12.B09, S12.B13, S12.B14, ADR-002] a bound but silent Host is unresponsive after 60 s, and Retry ends it only after the identity check, then respawns', async () => {
    const w = world()
    expect(await w.client.ensureHost()).toBe('available')
    await settle()
    // The Host hangs: its connection goes, and whatever holds the endpoint accepts and never answers.
    w.transport.hung = true
    w.host.dropConnections()
    await settle()
    expect(w.client.state().state).toBe('reconnecting')

    await elapse(w.timers, 59_750)
    expect(w.client.state().state).toBe('reconnecting')
    await elapse(w.timers, 500)
    expect(w.client.state()).toEqual({ state: 'unavailable', reason: 'unresponsive' })
    expect(w.pushes.at(-1)).toEqual({ state: 'unavailable', reason: 'unresponsive' })
    expect(w.ender.calls).toBe(0) // nothing is ended without the person's Retry
    const launches = w.launches()

    // Retry with a mismatching identity: the hello goes unanswered for 5 s, nothing is signalled, same message.
    w.ender.next = () => ({ outcome: 'identity-mismatch' })
    expect(await w.rows.serve('host:connection:retry', undefined)).toEqual({
      state: 'unavailable',
      reason: 'unresponsive'
    })
    await settle()
    await elapse(w.timers, 5_000)
    expect(w.ender.calls).toBe(1)
    expect(w.client.state()).toEqual({ state: 'unavailable', reason: 'unresponsive' })
    expect(w.launches()).toBe(launches)

    // Retry with a matching identity: that one process is ended, then a fresh Host is spawned and attached.
    w.ender.next = () => {
      w.transport.hung = false
      w.host.crash()
      return { outcome: 'ended' }
    }
    w.respawn.next = () => {
      w.host.restart()
      return 'spawned'
    }
    await w.rows.serve('host:connection:retry', undefined)
    await settle()
    await elapse(w.timers, 5_000)
    expect(w.ender.calls).toBe(2)
    expect(w.launches()).toBe(launches + 1)
    expect(w.client.state()).toEqual({
      state: 'connected',
      hostVersion: '0.0.0-fake',
      compat: false
    })
    expect(w.log.byEvent('host.hung-end').map((r) => [r.outcome, r.causeClass])).toEqual([
      ['skipped', 'identity-mismatch'],
      ['ok', 'ended']
    ])
  })
})
