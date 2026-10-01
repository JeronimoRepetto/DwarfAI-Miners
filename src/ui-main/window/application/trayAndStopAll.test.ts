// layer: L2
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHANNELS,
  type ChannelKey,
  type DwarfId,
  type DwarfWire,
  type SnapshotChunk,
  type StopAllOutcome
} from '@dwarfai/contracts'
import { createHostClient, type HostClientService } from '../../host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from '../../host-client/testing/FakeHost'
import { ManualTimers } from '../../host-client/testing/ManualTimers'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { FakeTrayController } from '../ports/fakes/FakeTrayController'
import type { TrayMenuModel } from '../ports/trayController'
import {
  createStopEverything,
  STOP_EVERYTHING_REQUESTED,
  type StopEverythingWindows
} from './stopEverything'
import { startTrayProcess } from './trayMenu'

// L2 (17 §1; 05 §3.14 tray boundary tests, OQ-47): the tray process of UI main — `TrayMenuModel` over
// `FakeTrayController`, the real HostClient against `FakeHost` (ISSUE-051), and a recording renderer bus — for
// ADR-002 D7, ADR-018 item 5 and 07 S10.13…S10.21. TC-053-01…TC-053-04.

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

/** Lets the in-memory pipes and the promises behind them settle. */
async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/**
 * The mode windows as the tray process sees them. A window open holds the HostClient's `ui` connection, as the window
 * relay does (it subscribes while a window is open, ADR-003 item 12); closing the last one drops it (S10.14).
 */
class FakeWindows implements StopEverythingWindows {
  opened = 0
  /** The recording renderer bus: every push UI main sent to the shown mode window, in order. */
  readonly pushes: Array<[ChannelKey, unknown]> = []
  private open_: Array<() => void> = []

  constructor(private readonly client: HostClientService) {}

  anyOpen(): boolean {
    return this.open_.length > 0
  }

  open(): void {
    this.opened += 1
    this.open_.push(this.client.subscribe(() => {}))
  }

  closeAll(): void {
    for (const unsubscribe of this.open_.splice(0)) unsubscribe()
  }

  push(channel: ChannelKey, payload: unknown): void {
    this.pushes.push([channel, payload])
  }
}

const CONFIRMATION_1 = '6f1d2c3b-4a59-4e6d-8c7b-9a0b1c2d3e41'
const CONFIRMATION_2 = '6f1d2c3b-4a59-4e6d-8c7b-9a0b1c2d3e42'
const R1 = '01890a5d-ac96-774b-bcce-b302099a8001'
const D1 = '01890a5d-ac96-774b-bcce-b302099ad001' as DwarfId
const D2 = '01890a5d-ac96-774b-bcce-b302099ad002' as DwarfId
const D3 = '01890a5d-ac96-774b-bcce-b302099ad003' as DwarfId

/** A dwarf as the snapshot carries it; only `owned` matters to the count (14 §2.2 A-N25 Notes). */
const dwarf = (id: string, owned: boolean): DwarfWire => ({ id, owned }) as DwarfWire
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
/** Two launched (owned) sessions and one observed one, across two snapshot pages. */
const BOARD: SnapshotChunk[] = [
  meta,
  { section: 'dwarfs', data: [dwarf(D1, true), dwarf(D3, false)] },
  { section: 'dwarfs', data: [dwarf(D2, true)] }
]
const shutdownAnswer = (outcome: StopAllOutcome) => () => ({ mode: 'stop-all', outcome })

async function world(options: { noSystemTray?: boolean } = {}) {
  const host = new FakeHost({ capabilities: [...FAKE_HOST_CAPABILITIES, 'section:dwarfs'] })
  host.board = BOARD
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
  const tray = new FakeTrayController(options)
  const windows = new FakeWindows(client)
  const sessionStore = { clears: 0, clear: () => (sessionStore.clears += 1) }
  const offered: TrayMenuModel[] = []
  const confirmationIds = [CONFIRMATION_1, CONFIRMATION_2]
  const stop = createStopEverything({
    host: client,
    windows,
    newConfirmationId: () => confirmationIds.shift() ?? 'no-more-ids'
  })
  let exits = 0
  const process = startTrayProcess({
    tray,
    windows,
    sessionStore,
    stopEverything: stop,
    onHostClosing: (h) => client.onClosing(h),
    exit: () => (exits += 1),
    offerFromWindow: (menu) => offered.push(menu)
  })
  return {
    host,
    client,
    tray,
    windows,
    sessionStore,
    stop,
    offered,
    process,
    exits: () => exits
  }
}

describe('the tray process (05 §3.14 TrayController; ADR-018 item 5; ADR-002 D7)', () => {
  it('[US-RES-002.AC05, S10.14] with the window closed and sessions running the tray icon stays and Open opens the window', async () => {
    const { tray, windows, host } = await world()
    windows.open()
    await settle()
    expect(host.liveConnections('ui')).toBe(1)

    windows.closeAll() // the person closes the last window (S10.14)
    await settle()
    expect(tray.iconShown).toBe(true)
    expect(tray.destroyCalls).toBe(0)
    expect(tray.entries).toEqual(['open', 'quit', '—', 'stop-everything'])

    tray.choose('open')
    await settle()
    expect(windows.anyOpen()).toBe(true)
    expect(windows.opened).toBe(2)
    expect(host.liveConnections('ui')).toBe(1)
  })

  it('[US-RES-002.AC06, S10.15, INV-122] tray Quit closes every window, sends no host.shutdown and nothing ends', async () => {
    const { tray, windows, host, sessionStore, exits } = await world()
    windows.open()
    windows.open()
    await settle()
    const sentBefore = host.received.length

    tray.choose('quit')
    await settle()

    expect(windows.anyOpen()).toBe(false)
    expect(sessionStore.clears).toBe(1)
    // No frame at all after Quit: no host.shutdown, no other mutation (14 §2.4 "No frame exists for: a Quit").
    expect(host.received.slice(sentBefore)).toEqual([])
    expect(host.methods()).not.toContain('host.shutdown')
    expect(exits()).toBe(0)
  })

  it('[US-RES-002.AC07] after Quit with launched sessions running the tray icon and the notifier connection stay', async () => {
    const { tray, windows, host, exits } = await world()
    windows.open()
    await settle()

    tray.choose('quit')
    await settle()

    expect(tray.iconShown).toBe(true)
    expect(tray.destroyCalls).toBe(0)
    expect(host.liveConnections('notifier')).toBe(1)
    expect(host.liveConnections('ui')).toBe(0)
    expect(exits()).toBe(0)
    // From tray-only, Quit changes nothing (S10.15).
    tray.choose('quit')
    await settle()
    expect(tray.iconShown).toBe(true)
    expect(host.liveConnections('notifier')).toBe(1)
  })

  it('[S10.16] the tray process exits with a Host that closes for the OS session end and stays through an upgrade drain', async () => {
    const upgrading = await world()
    upgrading.host.closeCleanly('upgrade')
    await settle()
    // ADR-002 D8: the UI starts the new Host and attaches again; the icon stays.
    expect(upgrading.exits()).toBe(0)
    expect(upgrading.tray.iconShown).toBe(true)

    const ending = await world()
    ending.windows.open()
    await settle()
    ending.host.closeCleanly('os-session-end')
    await settle()
    expect(ending.exits()).toBe(1)
    expect(ending.tray.iconShown).toBe(false)
    expect(ending.windows.anyOpen()).toBe(false)
  })

  it('[FM-050] with no system tray the app runs windowless and Stop everything is offered from the window', async () => {
    const { process, tray, windows, offered, exits, host } = await world({
      noSystemTray: true
    })

    expect(process.hasIcon).toBe(false)
    expect(tray.iconShown).toBe(false)
    expect(windows.opened).toBe(0)
    expect(exits()).toBe(0)
    expect(host.liveConnections('notifier')).toBe(1)
    const items = (offered.at(-1) ?? []).flatMap((entry) => (entry.kind === 'item' ? [entry] : []))
    expect(items.map((item) => item.id)).toEqual(['stop-everything'])

    items[0]?.choose()
    await settle()
    expect(windows.pushes).toEqual([
      [STOP_EVERYTHING_REQUESTED, { confirmationId: CONFIRMATION_1 }]
    ])
  })

  it('[US-RES-002.AC08, S10.18] Stop everything opens a short-lived ui connection and pushes the confirmation with the owned-session count', async () => {
    const { tray, windows, host, stop } = await world()
    expect(host.liveConnections('ui')).toBe(0)

    tray.choose('stop-everything')
    await settle()

    // The count is read on a ui connection no window held: the short-lived one (ADR-002 D7 step 1), every page.
    // (The window that opens attaches on its own ui connection and reads its own snapshot after it.)
    const first = host.received.find((r) => r.method === 'session.snapshot')
    expect(first?.role).toBe('ui')
    expect(first?.params).toEqual({ sections: ['dwarfs'] })
    const onShortLived = host.received.filter((r) => r.conn === first?.conn).map((r) => r.method)
    expect(onShortLived).toEqual(['session.snapshot', 'session.snapshot', 'session.snapshot'])
    expect(host.methods('notifier')).not.toContain('session.snapshot')
    // The Host-owned count only: two launched sessions; the observed one is not counted (OQ-78).
    expect(stop.pending()).toEqual({ confirmationId: CONFIRMATION_1, ownedCount: 2 })
    // No window was open, so one opens to show the confirmation; the push carries only its id (14 A-N25).
    expect(windows.opened).toBe(1)
    expect(windows.pushes).toEqual([
      [STOP_EVERYTHING_REQUESTED, { confirmationId: CONFIRMATION_1 }]
    ])
    const push = CHANNELS[STOP_EVERYTHING_REQUESTED].response
    expect(push.safeParse(windows.pushes[0]?.[1]).success).toBe(true)
    expect(host.liveConnections('ui')).toBe(2) // the short-lived one and the window's own
    expect(host.methods()).not.toContain('host.shutdown')
  })

  it('[US-RES-002.AC10, S10.19] Cancel sends nothing, closes the short-lived connection and every session keeps running', async () => {
    const { tray, windows, host, stop, exits } = await world()
    tray.choose('stop-everything')
    await settle()
    expect(host.liveConnections('ui')).toBe(2)
    const sentBefore = host.received.length

    stop.cancel({ confirmationId: CONFIRMATION_1 })
    await settle()

    expect(host.received.slice(sentBefore)).toEqual([])
    expect(host.methods()).not.toContain('host.shutdown')
    expect(host.liveConnections('ui')).toBe(1) // the window's own stays
    expect(host.liveConnections('notifier')).toBe(1)
    expect(stop.pending()).toBeNull()
    expect(tray.iconShown).toBe(true)
    expect(windows.anyOpen()).toBe(true)
    expect(exits()).toBe(0)
    // A late Confirm of the cancelled confirmation reaches nothing.
    expect(await stop.confirm({ confirmationId: CONFIRMATION_1, requestId: R1 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAMS' }
    })
    await settle()
    expect(host.methods()).not.toContain('host.shutdown')
  })

  it('[S10.20] Confirm sends host.shutdown stop-all on the ui connection only and the process exits on host.closing', async () => {
    const { tray, windows, host, stop, exits } = await world()
    host.handle('host.shutdown', shutdownAnswer({ ended: [D1, D2], failed: [] }))
    tray.choose('stop-everything')
    await settle()

    const answer = await stop.confirm({ confirmationId: CONFIRMATION_1, requestId: R1 })
    await settle()

    expect(answer).toEqual({ ok: true, value: { ended: [D1, D2], failed: [] } })
    const shutdowns = host.received.filter((r) => r.method === 'host.shutdown')
    expect(shutdowns.map((r) => [r.role, r.params])).toEqual([
      ['ui', { mode: 'stop-all', requestId: R1 }]
    ])
    expect(host.methods('notifier')).not.toContain('host.shutdown')
    // The outcome alone never ends the process: it waits for the Host's clean close (ADR-002 D7 step 4).
    expect(exits()).toBe(0)
    expect(tray.iconShown).toBe(true)

    host.closeCleanly('stop-all')
    await settle()

    expect(exits()).toBe(1)
    expect(tray.iconShown).toBe(false)
    expect(windows.anyOpen()).toBe(false)
  })

  it('[S10.21] a StopAllOutcome with failed dwarfs keeps windows, the notifier connection and the icon and produces one message', async () => {
    const { tray, windows, host, stop, exits } = await world()
    host.handle('host.shutdown', shutdownAnswer({ ended: [D1], failed: [D2] }))
    tray.choose('stop-everything')
    await settle()
    windows.closeAll() // the person closed the window that showed the confirmation
    await settle()

    const answer = await stop.confirm({ confirmationId: CONFIRMATION_1, requestId: R1 })
    await settle()

    // The one answer names every dwarf that could not be ended: the one danger message (ADR-014 item 9).
    expect(answer).toEqual({ ok: true, value: { ended: [D1], failed: [D2] } })
    expect(exits()).toBe(0)
    expect(tray.iconShown).toBe(true)
    expect(tray.destroyCalls).toBe(0)
    expect(host.liveConnections('notifier')).toBe(1)
    // With no window open, a window opens per "Mode at launch" to show it.
    expect(windows.anyOpen()).toBe(true)
    expect(windows.opened).toBe(2)
    // No per-dwarf toast nor any other push: only the confirmation request was ever pushed.
    expect(windows.pushes).toEqual([
      [STOP_EVERYTHING_REQUESTED, { confirmationId: CONFIRMATION_1 }]
    ])
    expect(host.liveConnections('ui')).toBe(1) // the short-lived one closed; the new window holds its own
    expect(stop.pending()).toBeNull()
  })
})
