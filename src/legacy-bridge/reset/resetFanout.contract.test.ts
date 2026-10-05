// layer: L6
// A-33 `resetMetrics` served `legacy` with `shape: 'target'` through `ResetFanout` (14 §2.1 A-33, §5; 21 §1 items 2,
// 2a, §3.1; 17 §1.6): the real router and its seam A gate, the registry's A-33 schemas, and the real HostClient
// against FakeHost answering B-M15. The legacy half is a scripted `metrics:reset` handler, as `LegacyRuntimeRoute`
// serves it. The route is the one the cut-1 switch (ISSUE-123) gives A-33.
import { afterEach, describe, expect, it } from 'vitest'
import { CHANNELS, type ChannelKey, type StepId } from '@dwarfai/contracts'
import { createHostClient, type HostClientService } from '../../ui-main/host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from '../../ui-main/host-client/testing/FakeHost'
import { FakeHostClientTimers } from '../../ui-main/host-client/testing/FakeHostClientTimers'
import { RecordingUiLog } from '../../ui-main/hostLauncher/fakes/RecordingUiLog'
import { checkRouteTable, type ChannelRoute } from '../../ui-main/ipc/channelRoute'
import { createRouter, type RouteTarget } from '../../ui-main/ipc/router'
import { LEGACY_BRIDGE_ADAPTERS } from '../../ui-main/ipc/routes'
import type { IpcSenderEvent, SenderPolicy } from '../../ui-main/ipc/senderCheck'
import {
  createResetFanout,
  RESET_FANOUT_CUTS,
  RESET_FANOUT_NAME,
  RESET_METRICS
} from './resetFanout'

const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id === PANEL_ID }
const FROM_PANEL: IpcSenderEvent = { sender: { id: PANEL_ID }, senderFrame: { url: APP_ENTRY } }
const RID_1 = '01890a5d-ac96-774b-bcce-b302099a8001'

/** A-33 as the cut-1 switch routes it: `legacy`, the target shape, through its named shape adapter. */
const A33: ChannelRoute = {
  channel: RESET_METRICS,
  owner: 'legacy',
  since: 'cut-1',
  parity: 'n/a',
  shape: 'target',
  shapeAdapter: RESET_FANOUT_NAME
}

/** Today's `metrics:reset` handler; every other legacy row is not served here. */
class ScriptedLegacyReset implements RouteTarget {
  readonly served: string[] = []
  serve(channel: string): Promise<unknown> {
    this.served.push(channel)
    if (channel !== RESET_METRICS)
      return Promise.reject(new Error(`legacy must not serve ${channel}`))
    return Promise.resolve({ outcome: 'reset' })
  }
}

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

async function world() {
  const host = new FakeHost({
    capabilities: [...FAKE_HOST_CAPABILITIES, 'preferences.resetMetrics']
  })
  host.handle('preferences.resetMetrics', () => ({ outcome: 'reset', epoch: 3 }))
  const client = createHostClient({
    launcher: { ensureHostRunning: () => Promise.resolve('attached') },
    connect: host.connect,
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers: new FakeHostClientTimers(),
    log: new RecordingUiLog(),
    hungHost: { endHungHost: () => Promise.resolve({ outcome: 'identity-missing' }) }
  })
  clients.push(client)
  await client.ensureHost()
  await settle()
  const legacy = new ScriptedLegacyReset()
  const fanout = createResetFanout({ legacy, hostClient: client, now: () => 0 })
  const router = createRouter({
    routes: [A33],
    legacy,
    shapeAdapters: { [RESET_FANOUT_NAME]: fanout },
    senders
  })
  const call = (payload: unknown): Promise<unknown> =>
    router.dispatch(RESET_METRICS, FROM_PANEL, payload)
  const hostResets = (): number =>
    host.methods().filter((method) => method === 'preferences.resetMetrics').length
  return { host, legacy, fanout, call, hostResets }
}

describe('A-33 resetMetrics through ResetFanout (14 §2.1 A-33; 21 §3.1)', () => {
  it('[ADR-001] A-33 served legacy with shape target through ResetFanout returns an IpcResult of MetricsResetResult', async () => {
    const { legacy, call, hostResets } = await world()

    const answer = await call({ confirmed: 'yes', requestId: RID_1 })

    expect(answer).toStrictEqual({ ok: true, value: { outcome: 'reset', epoch: 3 } })
    expect(CHANNELS[RESET_METRICS].response.safeParse(answer).success).toBe(true)
    expect(legacy.served).toStrictEqual([RESET_METRICS])
    expect(hostResets()).toBe(1)
  })

  it('[ADR-001] the router lists ResetFanout as a shape adapter for cuts 1–3e, and A-33 may name it only there', () => {
    expect(LEGACY_BRIDGE_ADAPTERS).toContainEqual({
      name: RESET_FANOUT_NAME,
      cuts: RESET_FANOUT_CUTS,
      shapeAdapter: true
    })
    const channels: ChannelKey[] = [RESET_METRICS]
    const problemsIn = (release: StepId) =>
      checkRouteTable(
        { release, routes: [A33], unrouted: {}, adapters: LEGACY_BRIDGE_ADAPTERS },
        channels
      )
    for (const release of RESET_FANOUT_CUTS) expect(problemsIn(release), release).toStrictEqual([])
    for (const release of ['cut-0', 'cut-4a'] as const) {
      expect(problemsIn(release), release).toStrictEqual([
        { reason: 'adapter-not-listed', adapter: RESET_FANOUT_NAME }
      ])
    }
  })

  it('[ADR-019] a request other than confirmed yes is refused in main and reaches neither reset', async () => {
    const { legacy, fanout, call, hostResets } = await world()
    const invalid: unknown[] = [
      undefined,
      { confirmed: 'no', requestId: RID_1 },
      { confirmed: 'YES', requestId: RID_1 },
      { confirmed: true, requestId: RID_1 },
      { confirmed: 'yes' },
      { confirmed: 'yes', requestId: 'not-a-uuid' },
      { confirmed: 'yes', requestId: RID_1, wipe: 'everything' }
    ]

    for (const payload of invalid) {
      // Through the seam A gate (ADR-019 items 7, 8) …
      const gated = (await call(payload)) as { ok: boolean; error?: { code: string } }
      expect(gated.ok, JSON.stringify(payload)).toBe(false)
      expect(gated.error?.code).toBe('INVALID_PARAMS')
      // … and by the adapter itself, should a payload ever reach it without the gate.
      await expect(fanout.serve(RESET_METRICS, payload)).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    await settle()
    expect(legacy.served).toStrictEqual([])
    expect(hostResets()).toBe(0)
  })
})
