// layer: L6
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { CHANNELS, type ChannelKey, type ChannelSpec } from '@dwarfai/contracts'
import { createHostClient, type HostClientService } from '../../host-client/HostClient'
import { FakeHost } from '../../host-client/testing/FakeHost'
import { ManualTimers } from '../../host-client/testing/ManualTimers'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import {
  createStopEverything,
  STOP_EVERYTHING_REQUESTED
} from '../../window/application/stopEverything'
import type { ChannelOwner, ChannelRoute } from '../channelRoute'
import { createRouter, type RouteTarget } from '../router'
import type { IpcSenderEvent, SenderPolicy } from '../senderCheck'
import {
  createStopEverythingRows,
  STOP_EVERYTHING_CANCEL,
  STOP_EVERYTHING_CONFIRM
} from './stopEverything'

/**
 * A-N25 `onStopEverythingRequested`, A-N26 `confirmStopEverything`, A-N27 `cancelStopEverything` (14 §2.2, §6.3;
 * ADR-002 D7; ADR-003 item 12): the real router and seam A gate, the real HostClient against FakeHost. The routes are
 * the ones ISSUE-056 gives the rows in cut 0, built from the registry's own placement (A-N26 `host`, A-N27 `ui-local`),
 * so the cases prove where the registry sends them, not where the test does.
 */
const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id === PANEL_ID }
const FROM_PANEL: IpcSenderEvent = { sender: { id: PANEL_ID }, senderFrame: { url: APP_ENTRY } }
const CONFIRMATION = '6f1d2c3b-4a59-4e6d-8c7b-9a0b1c2d3e41'
const R1 = '01890a5d-ac96-774b-bcce-b302099a8001'
const D1 = '01890a5d-ac96-774b-bcce-b302099ad001'
const D2 = '01890a5d-ac96-774b-bcce-b302099ad002'

const ownerOf = (placement: ChannelSpec<z.ZodTypeAny, z.ZodTypeAny>['placement']): ChannelOwner =>
  placement === 'host' ? 'host' : 'ui-local'
const routeOf = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: ownerOf(CHANNELS[channel].placement),
  since: 'cut-0',
  parity: CHANNELS[channel].placement === 'host' ? 'passed' : 'n/a',
  shape: 'target'
})

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

async function world() {
  const host = new FakeHost()
  host.handle('host.shutdown', () => ({
    mode: 'stop-all',
    outcome: { ended: [D1], failed: [D2] }
  }))
  const client = createHostClient({
    launcher: { ensureHostRunning: () => Promise.resolve('attached') },
    connect: host.connect,
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers: new ManualTimers(),
    log: new RecordingUiLog(),
    hungHost: { endHungHost: () => Promise.resolve({ outcome: 'identity-missing' }) }
  })
  clients.push(client)
  await client.ensureHost()
  await settle()
  const pushes: Array<[ChannelKey, unknown]> = []
  let windowOpen: (() => void) | null = null
  const stop = createStopEverything({
    host: client,
    windows: {
      anyOpen: () => windowOpen !== null,
      open: () => {
        windowOpen ??= client.subscribe(() => {})
      },
      push: (channel, payload) => pushes.push([channel, payload])
    },
    newConfirmationId: () => CONFIRMATION
  })
  const rows = createStopEverythingRows(stop)
  const legacy: RouteTarget = { serve: () => Promise.reject(new Error('never legacy')) }
  const rowKeys: ChannelKey[] = [
    STOP_EVERYTHING_REQUESTED,
    STOP_EVERYTHING_CONFIRM,
    STOP_EVERYTHING_CANCEL
  ]
  const router = createRouter({
    routes: rowKeys.map(routeOf),
    legacy,
    host: rows,
    uiLocal: rows,
    senders
  })
  const closeWindow = (): void => {
    windowOpen?.()
    windowOpen = null
  }
  return { host, client, stop, router, pushes, closeWindow }
}

describe('Stop everything and quit over seam A (14 §2.2 A-N25…A-N27, §6.3)', () => {
  it('[ADR-002] host.shutdown on the notifier connection is never sent', async () => {
    const { host, stop, router, closeWindow } = await world()
    // Only the notifier connection is open when the person chooses Stop everything (no window holds a ui one).
    expect(host.liveConnections('ui')).toBe(0)
    expect(host.liveConnections('notifier')).toBe(1)

    await stop.request()
    await settle()
    // The person closes the window that showed the confirmation before Confirm arrives: the only
    // ui connection left is the short-lived one, beside the notifier.
    closeWindow()
    await settle()
    expect(host.liveConnections('ui')).toBe(1)
    const answer = await router.dispatch(STOP_EVERYTHING_CONFIRM, FROM_PANEL, {
      confirmationId: CONFIRMATION,
      requestId: R1
    })
    await settle()

    expect(answer).toEqual({ ok: true, value: { ended: [D1], failed: [D2] } })
    expect(host.methods('notifier')).not.toContain('host.shutdown')
    expect(
      host.received.filter((r) => r.method === 'host.shutdown').map((r) => [r.role, r.params])
    ).toEqual([['ui', { mode: 'stop-all', requestId: R1 }]])
  })

  it('[ADR-002] A-N25, A-N26, A-N27 validate their schemas and A-N26 answers StopAllOutcome', async () => {
    const { host, stop, router, pushes } = await world()
    await stop.request()

    // A-N25: what UI main pushes passes its own row's schema.
    expect(pushes.map(([channel]) => channel)).toEqual([STOP_EVERYTHING_REQUESTED])
    expect(CHANNELS[STOP_EVERYTHING_REQUESTED].response.safeParse(pushes[0]?.[1]).success).toBe(
      true
    )

    // A-N27 with an invalid payload is dropped: the confirmation stays open, nothing is sent.
    for (const invalid of [
      { confirmationId: 42 },
      { confirmationId: CONFIRMATION, extra: 1 },
      undefined
    ]) {
      expect(await router.dispatch(STOP_EVERYTHING_CANCEL, FROM_PANEL, invalid)).toBeUndefined()
    }
    expect(stop.pending()?.confirmationId).toBe(CONFIRMATION)

    // A-N26 with an invalid payload is refused INVALID_PARAMS and relays nothing.
    for (const invalid of [
      { confirmationId: CONFIRMATION },
      { confirmationId: CONFIRMATION, requestId: 'not-a-uuid-v7' },
      { confirmationId: CONFIRMATION, requestId: R1, mode: 'stop-all' }
    ]) {
      expect(await router.dispatch(STOP_EVERYTHING_CONFIRM, FROM_PANEL, invalid)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    await settle()
    expect(host.methods()).not.toContain('host.shutdown')

    // A valid A-N26 answers the StopAllOutcome in the row's response shape.
    const answer = await router.dispatch(STOP_EVERYTHING_CONFIRM, FROM_PANEL, {
      confirmationId: CONFIRMATION,
      requestId: R1
    })
    expect(CHANNELS[STOP_EVERYTHING_CONFIRM].response.safeParse(answer).success).toBe(true)
    expect(answer).toEqual({ ok: true, value: { ended: [D1], failed: [D2] } })

    // A valid A-N27 for a confirmation that is not open (it was just confirmed) changes nothing and answers nothing.
    expect(
      await router.dispatch(STOP_EVERYTHING_CANCEL, FROM_PANEL, { confirmationId: CONFIRMATION })
    ).toBeUndefined()
    await settle()
    expect(host.methods().filter((m) => m === 'host.shutdown')).toHaveLength(1)
  })

  it('[ADR-002] a valid A-N27 closes the open confirmation and nothing reaches the Host', async () => {
    const { host, stop, router } = await world()
    await stop.request()
    await settle() // the window that opened for the confirmation has attached
    const sentBefore = host.received.length

    expect(
      await router.dispatch(STOP_EVERYTHING_CANCEL, FROM_PANEL, { confirmationId: CONFIRMATION })
    ).toBeUndefined()
    await settle()

    expect(stop.pending()).toBeNull()
    expect(host.received.slice(sentBefore)).toEqual([])
  })
})
