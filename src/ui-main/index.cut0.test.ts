// layer: L2
import { afterEach, describe, expect, it } from 'vitest'
import type {
  DwarfId,
  HostConnectionView,
  MineId,
  StepId,
  StopAllOutcome
} from '@dwarfai/contracts'
import { createHostClient, type HostClientService } from './host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from './host-client/testing/FakeHost'
import { FakeHostClientTimers } from './host-client/testing/FakeHostClientTimers'
import { RecordingUiLog } from './hostLauncher/fakes/RecordingUiLog'
import {
  startUiMain,
  windowFamilyOwner,
  type AppWindow,
  type CreatedWindow,
  type UiMainDeps,
  type UiMainLifecycle
} from './index'
import type { ChannelRoute } from './ipc/channelRoute'
import type { IpcMainRegistrar } from './ipc/router'
import type { UiLogEntry } from './diagnostics/uiLogger'
// AMENDED for ISSUE-123 (was: the release table `ROUTES` of './ipc/routes'): the release table is cut 1's from the
// cut-1 switch, so these cases compose the cut-0 table as it shipped, with its release.
import { CUT_0_ROUTES as ROUTES } from './ipc/testing/cut0Routes'
import { PRE_CUT_0_ROUTES } from './ipc/testing/preCutRoutes'
// AMENDED for ISSUE-141 (was: the release table `ROUTES` / `ROUTES_RELEASE` of './ipc/routes'): the release table is
// cut 2's from the cut-2 switch, so the cut-1 cases compose the cut-1 table as it shipped, with its release.
import { CUT_1_ROUTES as RELEASE_ROUTES } from './ipc/testing/cut1Routes'
const ROUTES_RELEASE = 'cut-1'
import type { IpcSenderEvent } from './ipc/senderCheck'
import { createPanelWindow, type PanelWindowUseCases } from './window/application/panelWindow'
import { createToggleShortcut } from './window/application/toggleShortcut'
import { FakeGlobalShortcutRegistry } from './window/ports/fakes/FakeGlobalShortcutRegistry'
import { FakeScreenAreaProvider } from './window/ports/fakes/FakeScreenAreaProvider'
import { FakeSingleInstanceLock } from './window/ports/fakes/FakeSingleInstanceLock'
import { FakeTrayController } from './window/ports/fakes/FakeTrayController'
import { FakeWindowFactory } from './window/ports/fakes/FakeWindowFactory'
import { InMemoryUiPreferenceStore } from './window/ports/fakes/InMemoryUiPreferenceStore'
import { RecordingNotificationDisplay } from './window/ports/fakes/RecordingNotificationDisplay'
import { FakeAutostartPort } from './window/ports/fakes/FakeAutostartPort'
import { createStartWithSystem } from './window/application/startWithSystem'
import { uiStartPlanOf } from './window/domain/uiStart'

/**
 * The cut-0 composition of UI main (ISSUE-056; 21 §2 cut 0; ADR-001 item 3): the route table serves the window
 * family, the Host connection rows, renderer diagnostics and the tray's confirmation rows `ui-local` and A-N26 `host`
 * (AMENDED for ISSUE-241: through `LegacyEndFirstAdapter` until the end of cut 4, straight to the Host since), so the
 * root composes their owners — the rebuilt Panel loaded at start, the rebuilt
 * tray and its Stop everything and quit, the A-N04 push, the rebuilt shortcut — and today's runtime without its window.
 */

const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL = 7
const FROM_PANEL: IpcSenderEvent = { sender: { id: PANEL }, senderFrame: { url: APP_ENTRY } }
const CONFIRMATION = '6f1d2c3b-4a59-4e6d-8c7b-9a0b1c2d3e41'
const REQUEST = '01890a5d-ac96-774b-bcce-b302099a8001'
const HOST_DWARF = '01890a5d-ac96-774b-bcce-b302099ad001' as DwarfId

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

class RecordingLifecycle implements UiMainLifecycle {
  readonly calls: string[] = []
  readonly handlers = new Map<string, () => void>()
  private ready: () => void = () => {}
  private readonly readyPromise = new Promise<void>((resolve) => (this.ready = resolve))
  private windowCreated: (window: CreatedWindow) => void = () => {}

  quit(): void {
    this.calls.push('quit')
  }
  exit(code: number): void {
    this.calls.push(`exit ${code}`)
  }
  whenReady(): Promise<void> {
    return this.readyPromise
  }
  onBeforeQuit(h: () => void): void {
    this.handlers.set('before-quit', h)
  }
  onWillQuit(h: () => void): void {
    this.handlers.set('will-quit', h)
  }
  onWindowAllClosed(h: () => void): void {
    this.handlers.set('window-all-closed', h)
  }
  onWindowCreated(h: (window: CreatedWindow) => void): void {
    this.windowCreated = h
  }
  /** Electron created a window whose `webContents` has `id` (the rebuilt Panel, built by its factory). */
  createWindow(id: number): void {
    this.windowCreated({ webContentsId: id, onClosed: () => {} })
  }
  becomeReady(): void {
    this.ready()
  }
}

class RecordingIpcMain implements IpcMainRegistrar {
  readonly handled = new Map<
    string,
    (event: IpcSenderEvent, payload: unknown) => Promise<unknown>
  >()
  readonly listened = new Map<string, (event: IpcSenderEvent, payload: unknown) => void>()
  handle(
    channel: string,
    listener: (event: IpcSenderEvent, payload: unknown) => Promise<unknown>
  ): void {
    this.handled.set(channel, listener)
  }
  on(channel: string, listener: (event: IpcSenderEvent, payload: unknown) => void): void {
    this.listened.set(channel, listener)
  }
}

/**
 * The earlier release tables as a root of this tree runs them. AMENDED for ISSUE-243, the deletion of today's runtime
 * (was: `legacyWithoutWindow`, today's runtime composed without a window through `LegacyRuntimeRoute`, serving the
 * `legacy` rows): today's runtime and its door left the tree (21 §2 cut 5), so the root binds no `legacy` target and a
 * table it starts has no `legacy` row; the cases below pin what the root itself composes over each table.
 */
const withoutLegacyRows = (routes: readonly ChannelRoute[]): readonly ChannelRoute[] =>
  routes.filter((route) => route.owner !== 'legacy')

/** The app's open windows as the root sees them: what each was pushed, and whether it was closed. */
class FakeAppWindows {
  readonly windows: Array<AppWindow & { pushes: Array<[string, unknown]>; closed: boolean }> = []
  open(webContentsId: number): void {
    const window = {
      webContentsId,
      pushes: [] as Array<[string, unknown]>,
      closed: false,
      send(push: string, payload: unknown) {
        window.pushes.push([push, payload])
      },
      close() {
        window.closed = true
      }
    }
    this.windows.push(window)
  }
  list = (): readonly AppWindow[] => this.windows.filter((w) => !w.closed)
}

/** The rebuilt Panel over the fake window factory, with the read-backs a fake surface gives. */
function rebuiltPanel(windows: FakeWindowFactory, onBuilt: () => void) {
  let built: PanelWindowUseCases | null = null
  const factory: NonNullable<UiMainDeps['panelWindow']> = () =>
    (built = createPanelWindow({
      windows: {
        panel: () => {
          if (windows.built.length === 0) onBuilt()
          return windows.panel()
        },
        veta: (key) => windows.veta(key),
        valle: (from) => windows.valle(from)
      },
      surface: {
        applyZoom: (factor) => factor,
        bounds: () => windows.panel().bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        setAlwaysOnTop: (on) => on,
        isAlwaysOnTop: () => false,
        raise: () => undefined,
        isMinimized: () => false,
        isVisible: () => windows.built.length > 0 && windows.panel().visible,
        onMinimizedChanged: () => undefined
      },
      screen: new FakeScreenAreaProvider([
        {
          displayKey: 'primary',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          primary: true
        }
      ]),
      store: new InMemoryUiPreferenceStore(),
      floor: 32,
      onDisplaysChanged: () => undefined
    }))
  return { factory, panel: () => built }
}

async function connectedClient(host: FakeHost): Promise<HostClientService> {
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
  return client
}

/** UI main started on the cut-0 table with every owner of a cut-0 row composed. */
async function cut0App(
  options: {
    routes?: readonly ChannelRoute[]
    /** The level-3 notification display and the S-018-1 gate (ISSUE-113); absent, no presenter is composed. */
    notifications?: { display: RecordingNotificationDisplay; drawsWithoutWindow: boolean }
    launch?: UiMainDeps['launch']
    startWithSystem?: UiMainDeps['startWithSystem']
    shellStart?: UiMainDeps['shellStart']
    onPanelBuilt?: () => void
    // AMENDED for ISSUE-123 (was: none of the three): the release the table is for (default the cut-0 table's) and the
    // Host methods advertised beyond the cut-0 ones. AMENDED for ISSUE-243 (was: also the answers of today's rows).
    release?: StepId
    capabilities?: readonly string[]
  } = {}
) {
  const lifecycle = new RecordingLifecycle()
  const ipc = new RecordingIpcMain()
  const lock = new FakeSingleInstanceLock(true)
  // The UI log, in the lifecycle's own order: a record made before an exit shows before it.
  const log: UiLogEntry[] = []
  const uiLog = {
    record: (entry: UiLogEntry) => {
      log.push(entry)
      lifecycle.calls.push(`log ${entry.event}`)
    },
    flush: async () => {
      lifecycle.calls.push('log flushed')
    }
  }
  // AMENDED for ISSUE-114 (was: without 'attention.clicked'): the Host serves B-M08 (host/transport), so a click's
  // counter is advertised as the real Host does; no other request uses it.
  const host = new FakeHost({
    capabilities: [
      ...FAKE_HOST_CAPABILITIES,
      'section:dwarfs',
      'attention.clicked',
      ...(options.capabilities ?? [])
    ]
  })
  host.board = [
    {
      section: 'meta',
      data: {
        hostVersion: '0.0.0-fake',
        state: 'ready',
        resetEpoch: 0,
        snapshotTail: 20,
        minesEverKnown: true
      }
    }
  ]
  const client = await connectedClient(host)
  const appWindows = new FakeAppWindows()
  const factory = new FakeWindowFactory()
  // Electron's `browser-window-created` for the rebuilt Panel, as its factory builds it.
  const panel = rebuiltPanel(factory, () => {
    options.onPanelBuilt?.()
    lifecycle.createWindow(PANEL)
    appWindows.open(PANEL)
  })
  const tray = new FakeTrayController()
  const shortcuts = new FakeGlobalShortcutRegistry()

  const started = startUiMain({
    lock,
    lifecycle,
    ipc,
    appEntry: APP_ENTRY,
    routes: withoutLegacyRows(options.routes ?? ROUTES),
    release: options.release ?? 'cut-0',
    panelWindow: panel.factory,
    uiLog,
    host: { client },
    appWindows: appWindows.list,
    tray: { controller: tray, newConfirmationId: () => CONFIRMATION },
    ...(options.notifications === undefined ? {} : { notifications: options.notifications }),
    shortcut: (controller) =>
      createToggleShortcut({
        registry: shortcuts,
        preference: { load: () => 'Control+Alt+Shift+P', save: () => {} },
        panel: controller,
        platform: 'win32'
      }),
    ...(options.launch === undefined ? {} : { launch: options.launch }),
    ...(options.startWithSystem === undefined ? {} : { startWithSystem: options.startWithSystem }),
    ...(options.shellStart === undefined ? {} : { shellStart: options.shellStart })
  })
  lifecycle.becomeReady()
  await started
  await settle()
  return {
    lifecycle,
    ipc,
    lock,
    host,
    client,
    appWindows,
    factory,
    panel,
    tray,
    shortcuts,
    log
  }
}

describe('the cut-0 composition of UI main (21 §2 cut 0)', () => {
  // AMENDED for ISSUE-243 (was: "…, and today’s runtime is composed without a window"): today's runtime left the tree.
  it('[ADR-001] in cut 0 the root loads the rebuilt Panel hidden once the app is ready and a second launch shows it', async () => {
    const { factory, panel, lock, lifecycle } = await cut0App()

    expect(factory.built).toEqual([{ kind: 'panel' }])
    expect(factory.panel().visible).toBe(false)
    lock.launchAgain()
    expect(panel.panel()?.visible()).toBe(true)
    expect(lifecycle.calls.filter((call) => call.startsWith('exit'))).toEqual([])
  })

  // AMENDED for ISSUE-241, the end of cut 4 (was: "… ends a legacy-launched session before host.shutdown stop-all is
  // relayed", through `LegacyEndFirstAdapter`): A-N26 reaches the Host alone, and today's runtime is not asked.
  it('[ADR-002] in cut 0 the rebuilt tray’s Stop everything and quit relays host.shutdown stop-all to the Host alone', async () => {
    const { tray, host, ipc, appWindows } = await cut0App()
    expect(tray.entries).toEqual(['open', 'quit', '—', 'stop-everything'])
    const outcome: StopAllOutcome = { ended: [HOST_DWARF], failed: [] }
    host.handle('host.shutdown', () => ({ mode: 'stop-all', outcome }))

    tray.choose('stop-everything')
    await settle()
    expect(appWindows.windows[0]?.pushes).toContainEqual([
      'tray:stopEverything:requested',
      { confirmationId: CONFIRMATION }
    ])
    const confirm = ipc.handled.get('tray:stopEverything:confirm')
    const answer = await confirm?.(FROM_PANEL, { confirmationId: CONFIRMATION, requestId: REQUEST })

    expect(answer).toEqual({ ok: true, value: outcome })
    expect(host.received.filter((r) => r.method === 'host.shutdown').map((r) => r.params)).toEqual([
      { mode: 'stop-all', requestId: REQUEST }
    ])
  })

  it('[ADR-001] in cut 0 A-N03 answers the Host connection view and A-N04 pushes it to the mode windows on every state change', async () => {
    const { ipc, appWindows } = await cut0App()

    const view = (await ipc.handled.get('host:connection:get')?.(FROM_PANEL, undefined)) as
      HostConnectionView | undefined
    expect(view?.state).toBe('connected')
    const pushed = (appWindows.windows[0]?.pushes ?? [])
      .filter(([push]) => push === 'host:connection:changed')
      .map(([, payload]) => (payload as HostConnectionView).state)
    expect(pushed.at(-1)).toBe('connected')
  })

  it('[ADR-024] in cut 0 the rebuilt shortcut is registered once the app is ready, A-10 answers it and will-quit releases it', async () => {
    const { ipc, shortcuts, lifecycle } = await cut0App()

    expect(shortcuts.heldAccelerators).toEqual(['Control+Alt+Shift+P'])
    expect(await ipc.handled.get('shortcut:get')?.(FROM_PANEL, undefined)).toEqual({
      accelerator: 'Control+Alt+Shift+P',
      registered: true,
      platform: 'win32'
    })
    lifecycle.handlers.get('will-quit')?.()
    expect(shortcuts.heldAccelerators).toEqual([])
  })

  it('[ADR-001] the window family is served by one owner: a table that splits it between legacy and ui-local is refused', () => {
    expect(windowFamilyOwner(ROUTES)).toBe('ui-local')
    expect(windowFamilyOwner(PRE_CUT_0_ROUTES)).toBe('legacy')
    const split = ROUTES.map((route) =>
      route.channel === 'panel:hide' ? { ...route, owner: 'legacy' as const } : route
    )
    expect(() => windowFamilyOwner(split)).toThrow(/window family/)
  })

  // AMENDED for ISSUE-243 (was: '[ADR-001] with the window family served legacy (a rollback build) the root keeps
  // today’s Panel and composes no rebuilt Panel, tray or shortcut'): today's runtime, which served that family, left the
  // tree (21 §2 cut 5), so no build can serve it: such a table is refused, as a split one is.
  it('[ADR-001] a table that serves the window family legacy is refused and builds no Panel, tray or shortcut', async () => {
    const lifecycle = new RecordingLifecycle()
    const factory = new FakeWindowFactory()
    const tray = new FakeTrayController()
    const shortcuts = new FakeGlobalShortcutRegistry()
    const ipc = new RecordingIpcMain()
    const started = startUiMain({
      lock: new FakeSingleInstanceLock(true),
      lifecycle,
      ipc,
      appEntry: APP_ENTRY,
      routes: PRE_CUT_0_ROUTES,
      panelWindow: rebuiltPanel(factory, () => {}).factory,
      tray: { controller: tray, newConfirmationId: () => CONFIRMATION },
      shortcut: (controller) =>
        createToggleShortcut({
          registry: shortcuts,
          preference: { load: () => 'Control+Alt+Shift+P', save: () => {} },
          panel: controller,
          platform: 'win32'
        })
    })
    lifecycle.becomeReady()

    await expect(started).rejects.toThrow(/window family legacy/)
    expect([...ipc.handled.keys(), ...ipc.listened.keys()]).toEqual([])
    expect(factory.built).toEqual([])
    expect(tray.createCalls).toEqual([])
    expect(shortcuts.registerCalls).toEqual([])
  })

  it("[S10.14, S10.15, NFR-PERS-06] the tray's Quit and the last window closing each clear the UI session store", async () => {
    // The table the cut-1 switch (ISSUE-123) gives the session rows: `ui-local`, target shape.
    const sessionRoutes: ChannelRoute[] = (
      ['ui:session:get', 'ui:session:patch', 'ui:session:changed'] as const
    ).map((channel) => ({
      channel,
      owner: 'ui-local',
      since: 'cut-1',
      parity: 'n/a',
      shape: 'target'
    }))
    const { ipc, tray, lifecycle } = await cut0App({ routes: [...ROUTES, ...sessionRoutes] })
    const patch = ipc.listened.get('ui:session:patch')
    const read = () => ipc.handled.get('ui:session:get')?.(FROM_PANEL, undefined)
    const draft = { kind: 'draft', dwarfId: HOST_DWARF, text: 'half a thought' }
    const empty = {
      drafts: {},
      chatViews: {},
      askPicks: {},
      openChat: {},
      currentMine: {},
      valle: {}
    }

    patch?.(FROM_PANEL, draft)
    await settle()
    expect(await read()).toEqual({ ...empty, drafts: { [HOST_DWARF]: 'half a thought' } })
    tray.choose('quit')
    expect(await read()).toEqual(empty)

    patch?.(FROM_PANEL, draft)
    await settle()
    expect(await read()).toEqual({ ...empty, drafts: { [HOST_DWARF]: 'half a thought' } })
    lifecycle.handlers.get('window-all-closed')?.()
    expect(await read()).toEqual(empty)
  })

  it('[S10.03, US-RES-002.AC13] a --background start builds no window and starts the tray; the person opening the app shows the Panel', async () => {
    const { factory, panel, lock, tray } = await cut0App({
      launch: uiStartPlanOf(['DwarfAI-Miners.exe', '--background'])
    })

    // Tray-only (S10.03): the tray, no window built. AMENDED for ISSUE-243 (was: also today's runtime composed).
    expect(factory.built).toEqual([])
    expect(tray.entries).toEqual(['open', 'quit', '—', 'stop-everything'])
    // The person opens the app (a second launch, S10.13): the Panel is built and shown.
    lock.launchAgain()
    expect(factory.built).toEqual([{ kind: 'panel' }])
    expect(panel.panel()?.visible()).toBe(true)
  })

  it('[S40.02, ADR-027] every start, normal or --background, applies Start with the system before any window is built', async () => {
    for (const argv of [['DwarfAI-Miners.exe'], ['DwarfAI-Miners.exe', '--background']]) {
      const entry = new FakeAutostartPort()
      const store = new InMemoryUiPreferenceStore()
      store.save('startWithSystem', false)
      entry.entry = 'enabled'
      const order: string[] = []
      const startWithSystem = createStartWithSystem({
        autostart: entry,
        store,
        log: (record) => order.push(`${record.event} ${record.causeClass}`)
      })
      await cut0App({
        launch: uiStartPlanOf(argv),
        startWithSystem,
        onPanelBuilt: () => order.push('panel built')
      })

      // The stored OFF is re-applied: the entry found at the start is removed and OFF stays stored.
      expect(entry.entry, argv.join(' ')).toBe('absent')
      expect(store.load('startWithSystem')).toBe(false)
      expect(order[0], argv.join(' ')).toBe('autostart.register removed')
    }
  })

  // AMENDED for ISSUE-243 (was: "…, and today’s runtime is composed after it"): today's runtime left the tree, so the
  // shell start is the last of the start.
  it('[ADR-001] the shell start (the Dock, the .env file, the candidate login entry) runs once, after the Panel is built', async () => {
    const order: string[] = []
    const { lifecycle } = await cut0App({
      onPanelBuilt: () => order.push('panel built'),
      shellStart: {
        start: async () => {
          order.push('shell start')
        }
      }
    })

    expect(order).toEqual(['panel built', 'shell start'])
    expect(lifecycle.calls.filter((call) => call.startsWith('exit'))).toEqual([])
  })

  // AMENDED for ISSUE-243 (was: "… and composes nothing of today’s runtime"): today's runtime left the tree.
  it('[ADR-026] a shell start that fails records ui.start failed at the shell step', async () => {
    const { log, lifecycle } = await cut0App({
      shellStart: {
        start: async () => {
          throw Object.assign(new Error(String.raw`no .env at C:\Users\j\x`), { code: 'EACCES' })
        }
      }
    })

    expect(log.filter((entry) => entry.event === 'ui.start')).toEqual([
      {
        level: 'error',
        event: 'ui.start',
        subsystem: 'ui-main',
        outcome: 'failed',
        causeClass: 'shell',
        errCode: 'EACCES'
      }
    ])
    expect(lifecycle.calls).toContain('exit 1')
  })

  it('[ADR-026] a start that fails records ui.start failed with its step and error class, never its message, before it exits with code 1', async () => {
    // AMENDED for ISSUE-243 (was: today's runtime failing to compose, step `legacy-compose`, whose message named a
    // path): that step left with today's runtime, so a shell start fails here with a message naming a path.
    const { log, lifecycle } = await cut0App({
      shellStart: {
        start: async () => {
          throw new Error(String.raw`the shell could not start at C:\Users\j\x`)
        }
      }
    })

    expect(log.filter((entry) => entry.event === 'ui.start')).toEqual([
      {
        level: 'error',
        event: 'ui.start',
        subsystem: 'ui-main',
        outcome: 'failed',
        causeClass: 'shell',
        errCode: 'Error'
      }
    ])
    // Written out before the process ends, so the failure leaves a trace.
    const calls = lifecycle.calls
    expect(calls.indexOf('log ui.start')).toBeLessThan(calls.indexOf('log flushed'))
    expect(calls.indexOf('log flushed')).toBeLessThan(calls.indexOf('exit 1'))
  })

  it("[ADR-018] in cut 0 the root draws the notifier's attention frames through the notification display, unchanged, and stops at will-quit", async () => {
    const display = new RecordingNotificationDisplay()
    const { host, lifecycle, panel } = await cut0App({
      notifications: { display, drawsWithoutWindow: false }
    })
    const notification = {
      key: `${HOST_DWARF}:question:ask-1`,
      kind: 'question',
      title: 'Ember has a question',
      body: 'Mine one',
      mineId: '01890a5d-ac96-774b-bcce-b302099a8111',
      dwarfId: HOST_DWARF,
      sensitive: true
    }

    // The Panel is open: drawn even where S-018-1 has not passed (window-only fallback).
    panel.panel()?.show()
    host.publishToNotifiers('attention.notify', notification)
    await settle()
    expect(display.shown).toEqual([
      { key: notification.key, title: 'Ember has a question', body: 'Mine one' }
    ])
    host.publishToNotifiers('attention.withdraw', { keys: [notification.key] })
    await settle()
    expect(display.closed).toEqual([notification.key])

    // Tray mode where S-018-1 has not passed: not drawn.
    panel.panel()?.hide()
    host.publishToNotifiers('attention.notify', { ...notification, key: 'k2' })
    await settle()
    expect(display.shown).toHaveLength(1)

    panel.panel()?.show()
    lifecycle.handlers.get('will-quit')?.()
    host.publishToNotifiers('attention.notify', { ...notification, key: 'k3' })
    await settle()
    expect(display.shown).toHaveLength(1)
  })

  it('[ADR-018, S17.06] a notification click reports attention.clicked and reaches the Panel as A-N16 only once the table routes A-N16', async () => {
    const notification = {
      key: `${HOST_DWARF}:question:ask-1`,
      kind: 'question',
      title: 'Ember has a question',
      body: 'Mine one',
      mineId: '01890a5d-ac96-774b-bcce-b302099a8111',
      dwarfId: HOST_DWARF,
      sensitive: true
    }
    const clickIn = async (routes: readonly ChannelRoute[]) => {
      const display = new RecordingNotificationDisplay()
      const app = await cut0App({ routes, notifications: { display, drawsWithoutWindow: false } })
      app.panel.panel()?.show()
      app.host.publishToNotifiers('attention.notify', notification)
      await settle()
      expect(display.click(notification.key)).toBe(true)
      await settle()
      const reveals = app.appWindows.windows.flatMap((w) =>
        w.pushes.filter(([push]) => push === 'mode:revealDwarfChat')
      )
      return { app, reveals }
    }

    // Cut 0: A-N16 is not routed (unrouted until the cut-1 switch, ISSUE-123): the click only logs, as before; no
    // counter for a reveal that did not run, no push, and the Panel is not brought up for it.
    const cut0 = await clickIn(ROUTES)
    expect(cut0.app.host.methods('notifier')).not.toContain('attention.clicked')
    expect(cut0.reveals).toEqual([])
    expect(cut0.app.log.filter((entry) => entry.event === 'window.raise')).toEqual([])

    // The table the cut-1 switch gives A-N16: `ui-local`, target shape.
    const revealRoute: ChannelRoute = {
      channel: 'mode:revealDwarfChat',
      owner: 'ui-local',
      since: 'cut-1',
      parity: 'n/a',
      shape: 'target'
    }
    const cut1 = await clickIn([...ROUTES, revealRoute])
    expect(cut1.app.host.methods('notifier')).toContain('attention.clicked')
    expect(cut1.reveals).toEqual([
      ['mode:revealDwarfChat', { mineId: notification.mineId, dwarfId: HOST_DWARF }]
    ])
  })
})

// AMENDED for ISSUE-123 (appended): the same root over the release table of the cut-1 switch (21 §2 cut 1).
describe('the cut-1 composition of UI main (21 §2 cut 1)', () => {
  const MINE = '01890a5d-ac96-774b-bcce-b302099a0001' as MineId
  /** The cut-1 Host methods the rows below relay (21 §2 "Seam B members", row 1). */
  const CUT_1_METHODS = [
    'conversation.feed',
    'conversation.mineHistory',
    'presence',
    'preferences.resetMetrics'
  ]
  // AMENDED for ISSUE-236, the 4a retirement (was: the cut-1 table as it shipped, A-33 through `ResetFanout`): the
  // adapter left the tree, so the root of this tree cannot bind it. AMENDED for ISSUE-243 (was: A-33 kept its pre-cut
  // `legacy` row here): today's runtime left the tree too, so A-33 has no row and the other cut-1 rows run as they
  // shipped, without their `legacy` rows (`withoutLegacyRows`).
  const cut1Routes = RELEASE_ROUTES.filter((route) => route.channel !== 'metrics:reset')
  const cut1App = (options: Parameters<typeof cut0App>[0] = {}) =>
    cut0App({
      routes: cut1Routes,
      release: ROUTES_RELEASE,
      capabilities: CUT_1_METHODS,
      ...options
    })

  it('[ADR-001] in cut 1 the root relays A-N01, pushes every Host frame as A-N02 and reads A-15 and A-19 from the Host message log', async () => {
    expect(ROUTES_RELEASE).toBe('cut-1')
    const { ipc, host, appWindows } = await cut1App()
    host.handle('conversation.feed', () => ({
      dwarfId: HOST_DWARF,
      messages: [],
      reachedStart: true
    }))
    host.handle('conversation.mineHistory', () => ({ mineId: MINE, speakers: [] }))

    const snapshot = (await ipc.handled.get('host:snapshot')?.(FROM_PANEL, {})) as {
      ok: boolean
    }
    expect(snapshot.ok).toBe(true)
    expect(await ipc.handled.get('dwarf:feed:page')?.(FROM_PANEL, { dwarfId: HOST_DWARF })).toEqual(
      { ok: true, value: { dwarfId: HOST_DWARF, messages: [], reachedStart: true } }
    )
    expect(await ipc.handled.get('mine:history')?.(FROM_PANEL, MINE)).toEqual({
      ok: true,
      value: { mineId: MINE, speakers: [] }
    })
    expect(host.methods('ui')).toEqual(
      expect.arrayContaining(['session.snapshot', 'conversation.feed', 'conversation.mineHistory'])
    )

    // A Host frame reaches the Panel as one A-N02 batch.
    host.publish('dwarf.departed', { dwarfId: HOST_DWARF, mineId: MINE, cause: 'stopped' })
    await settle()
    const batches = appWindows.windows.flatMap((w) => w.pushes.filter(([p]) => p === 'host:event'))
    expect(
      batches.map(([, batch]) => (batch as Array<{ name: string }>).map((f) => f.name))
    ).toEqual([['dwarf.departed']])
  })

  it('[ADR-024] in cut 1 A-44 tells the Host which mines the shown Panel draws, once its report settled', async () => {
    const { ipc, host, panel } = await cut1App()
    expect(ipc.listened.has('panel:openMine')).toBe(false)
    panel.panel()?.show()
    ipc.listened.get('presence:visibleMines')?.(FROM_PANEL, { mineIds: [MINE] })
    // ADR-024 item 7: a report settles once it held for 100 ms.
    await new Promise((resolve) => setTimeout(resolve, 150))
    await settle()
    const sent = host.received.filter((r) => r.method === 'presence').map((r) => r.params)
    expect(sent.at(-1)).toMatchObject({ onScreenMineIds: [MINE], anyWindowVisible: true })
  })

  // AMENDED for ISSUE-243 (was: "… reach neither today’s runtime nor the Host"): today's runtime left the tree.
  it('[ADR-001] in cut 1 the retired rows do not reach the Host', async () => {
    const { ipc, host } = await cut1App()
    const before = host.received.length
    for (const wire of ['dwarf:feed', 'dwarf:setTuning']) {
      expect(await ipc.handled.get(wire)?.(FROM_PANEL, 'claude:s1'), wire).toMatchObject({
        ok: false,
        error: { code: 'METHOD_NOT_FOUND' }
      })
    }
    ipc.listened.get('panel:watchDwarfFeed')?.(FROM_PANEL, 'claude:s1')
    ipc.listened.get('dwarf:refreshTelemetry')?.(FROM_PANEL, 'claude:s1')
    await settle()
    expect(host.received.length).toBe(before)
  })
})
