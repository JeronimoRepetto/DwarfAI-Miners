// layer: L2
import { afterEach, describe, expect, it } from 'vitest'
import { createHostClient, type HostClientService } from '../../host-client/HostClient'
import { FakeHost } from '../../host-client/testing/FakeHost'
import { ManualTimers } from '../../host-client/testing/ManualTimers'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { FakeTrayController } from '../ports/fakes/FakeTrayController'
import type { TrayMenuModel } from '../ports/trayController'
import { startTrayProcess, type TrayWindows } from './trayMenu'

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
class FakeWindows implements TrayWindows {
  opened = 0
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
}

async function world(options: { noSystemTray?: boolean } = {}) {
  const host = new FakeHost()
  const client = createHostClient({
    launcher: { ensureHostRunning: () => Promise.resolve('attached') },
    connect: host.connect,
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers: new ManualTimers(),
    log: new RecordingUiLog()
  })
  clients.push(client)
  await client.ensureHost()
  await settle()
  const tray = new FakeTrayController(options)
  const windows = new FakeWindows(client)
  const sessionStore = { clears: 0, clear: () => (sessionStore.clears += 1) }
  const stopRequests: string[] = []
  const offered: TrayMenuModel[] = []
  let exits = 0
  const process = startTrayProcess({
    tray,
    windows,
    sessionStore,
    stopEverything: { request: () => stopRequests.push('requested') },
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
    stopRequests,
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

  it('[FM-050] with no system tray the app runs windowless and Stop everything is offered from the window', async () => {
    const { process, tray, windows, offered, stopRequests, exits, host } = await world({
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
    expect(stopRequests).toEqual(['requested'])
  })
})
