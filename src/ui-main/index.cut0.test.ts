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
import { ROUTES as RELEASE_ROUTES, ROUTES_RELEASE } from './ipc/routes'
import type { IpcSenderEvent } from './ipc/senderCheck'
import { createPanelWindow, type PanelWindowUseCases } from './window/application/panelWindow'
import { createToggleShortcut } from './window/application/toggleShortcut'
import { FakeGlobalShortcutRegistry } from './window/ports/fakes/FakeGlobalShortcutRegistry'
import { FakePanelWindowController } from './window/ports/fakes/FakePanelWindowController'
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
 * through `LegacyEndFirstAdapter`, so the root composes their owners — the rebuilt Panel loaded at start, the rebuilt
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
 * Today's runtime as the root reaches it: no window of its own in cut 0, one live legacy launch. AMENDED for ISSUE-123
 * (was: every row answered `undefined`): a row named in `answers` answers that, so a case can pin a legacy answer.
 */
function legacyWithoutWindow(
  endVerdict: 'ended' | 'refused' = 'ended',
  composeFails = false,
  answers: Readonly<Record<string, unknown>> = {}
) {
  const events: string[] = []
  const counts = { composed: 0 }
  const legacyRuntime: UiMainDeps['legacyRuntime'] = {
    async compose() {
      counts.composed += 1
      if (composeFails) throw new Error(String.raw`today’s runtime could not start at C:\Users\j\x`)
      return null
    },
    async serve(channel) {
      events.push(`legacy serve ${channel}`)
      return answers[channel]
    },
    beforeQuit() {},
    willQuit() {},
    liveLaunches: async () => [{ launchId: 'launch:1' }],
    async endLaunch(launchId) {
      events.push(`legacy end ${launchId}`)
      return endVerdict
    }
  }
  return { legacyRuntime, events, counts }
}

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
    endVerdict?: 'ended' | 'refused'
    routes?: readonly ChannelRoute[]
    composeFails?: boolean
    /** The level-3 notification display and the S-018-1 gate (ISSUE-113); absent, no presenter is composed. */
    notifications?: { display: RecordingNotificationDisplay; drawsWithoutWindow: boolean }
    launch?: UiMainDeps['launch']
    startWithSystem?: UiMainDeps['startWithSystem']
    onPanelBuilt?: () => void
    // AMENDED for ISSUE-123 stage (a) (was: neither): today's runtime as the feed is handed it, and the tap its pushes
    // pass through, as the production root passes both; absent, the start is the one every case above pins.
    legacyRegistry?: UiMainDeps['legacyRegistry']
    legacyPushes?: UiMainDeps['legacyPushes']
    // AMENDED for ISSUE-123 (was: none of the three): the release the table is for (default the cut-0 table's), the
    // Host methods advertised beyond the cut-0 ones, and the answers of today's rows.
    release?: StepId
    capabilities?: readonly string[]
    legacyAnswers?: Readonly<Record<string, unknown>>
  } = {}
) {
  const lifecycle = new RecordingLifecycle()
  const ipc = new RecordingIpcMain()
  const lock = new FakeSingleInstanceLock(true)
  const legacy = legacyWithoutWindow(
    options.endVerdict,
    options.composeFails === true,
    options.legacyAnswers
  )
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
    legacyRuntime: legacy.legacyRuntime,
    ipc,
    appEntry: APP_ENTRY,
    routes: options.routes ?? ROUTES,
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
    ...(options.legacyRegistry === undefined ? {} : { legacyRegistry: options.legacyRegistry }),
    ...(options.legacyPushes === undefined ? {} : { legacyPushes: options.legacyPushes })
  })
  lifecycle.becomeReady()
  await started
  await settle()
  return {
    lifecycle,
    ipc,
    lock,
    legacy,
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
  it('[ADR-001] in cut 0 the legacy runtime surface composes no cut-1 bridge: no discovery, no B-M41 read, A-13 and A-40 reach today’s runtime unchanged and A-P4 leaves unmapped', async () => {
    // ISSUE-123 stage (a): the production root now passes today's runtime as the feed is handed it and the push tap.
    // In this release's table none of the adapters 21 §3 lists from cut 1 is composed over them
    // (`LEGACY_BRIDGE_ADAPTERS`), so the start is today's: nothing new runs and no row or push changes.
    const scans: string[] = []
    const written: unknown[] = []
    const reached: string[] = []
    const surface: NonNullable<UiMainDeps['legacyRegistry']> = {
      pollIntervalMs: 2_000,
      discovery: (['claude', 'codex', 'antigravity', 'opencode'] as const).map((kind) => ({
        kind,
        scan: async () => {
          scans.push(kind)
          return []
        }
      })),
      registry: { replace: (sessions) => written.push(sessions) },
      board: { publish: () => reached.push('board') },
      ledger: { credit: () => reached.push('ledger') },
      projects: { record: () => reached.push('projects') },
      notifier: { update: () => reached.push('notifier') }
    }
    // The tap today's pushes pass through: a mapping installed on it is `LegacyDwarfIdBridge`'s A-P4 mapping.
    let installed = 0
    const pushes: NonNullable<UiMainDeps['legacyPushes']> = {
      send: (channel, payload, deliver) => deliver(channel, payload),
      install: () => {
        installed += 1
        return () => {}
      }
    }
    const { ipc, host, legacy } = await cut0App({ legacyRegistry: surface, legacyPushes: pushes })
    const call = (channel: string, payload: unknown) =>
      (ipc.handled.get(channel) ?? ipc.listened.get(channel))?.(FROM_PANEL, payload)

    await call('dwarf:activate', 'claude:s-1')
    await call('agent:answerQuestion', {
      dwarfId: 'claude:s-1',
      toolUseId: 'legacy:toolu_1',
      answers: { 'Which one?': 'The first' }
    })
    const delivered: Array<[string, unknown]> = []
    const settled = { dwarfId: 'claude:s-1', holdId: 'hold-1', delivered: true }
    pushes.send('dwarf:sendText:settled', settled, (push, payload) =>
      delivered.push([push, payload])
    )
    await settle()

    expect(scans).toEqual([])
    expect(written).toEqual([])
    expect(reached).toEqual([])
    expect(host.received.map((request) => request.method)).not.toContain(
      'strangler.dwarfIdentities'
    )
    expect(legacy.events).toEqual(
      expect.arrayContaining(['legacy serve dwarf:activate', 'legacy serve agent:answerQuestion'])
    )
    expect(installed).toBe(0)
    expect(delivered).toEqual([['dwarf:sendText:settled', settled]])
  })

  it('[ADR-001] in cut 0 the root loads the rebuilt Panel hidden once the app is ready, a second launch shows it, and today’s runtime is composed without a window', async () => {
    const { factory, panel, lock, legacy, lifecycle } = await cut0App()

    expect(legacy.counts.composed).toBe(1)
    expect(factory.built).toEqual([{ kind: 'panel' }])
    expect(factory.panel().visible).toBe(false)
    lock.launchAgain()
    expect(panel.panel()?.visible()).toBe(true)
    expect(lifecycle.calls.filter((call) => call.startsWith('exit'))).toEqual([])
  })

  it('[ADR-002] in cut 0 the rebuilt tray’s Stop everything and quit ends a legacy-launched session before host.shutdown stop-all is relayed', async () => {
    const { tray, host, ipc, legacy, appWindows } = await cut0App()
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
    expect(legacy.events).toEqual(['legacy end launch:1'])
    expect(host.received.filter((r) => r.method === 'host.shutdown').map((r) => r.params)).toEqual([
      { mode: 'stop-all', requestId: REQUEST }
    ])
  })

  it('[ADR-002] in cut 0 a legacy-launched session that cannot be ended relays nothing and A-N26 answers INTERNAL', async () => {
    const { tray, host, ipc } = await cut0App({ endVerdict: 'refused' })

    tray.choose('stop-everything')
    await settle()
    const answer = await ipc.handled.get('tray:stopEverything:confirm')?.(FROM_PANEL, {
      confirmationId: CONFIRMATION,
      requestId: REQUEST
    })

    expect(answer).toMatchObject({ ok: false, error: { code: 'INTERNAL', retryable: false } })
    expect(host.received.filter((r) => r.method === 'host.shutdown')).toEqual([])
    expect(tray.iconShown).toBe(true)
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

  it('[ADR-001] with the window family served legacy (a rollback build) the root keeps today’s Panel and composes no rebuilt Panel, tray or shortcut', async () => {
    const lifecycle = new RecordingLifecycle()
    const legacyPanel = new FakePanelWindowController({ visible: false })
    const lock = new FakeSingleInstanceLock(true)
    const factory = new FakeWindowFactory()
    const tray = new FakeTrayController()
    const shortcuts = new FakeGlobalShortcutRegistry()
    const started = startUiMain({
      lock,
      lifecycle,
      legacyRuntime: {
        compose: async () => legacyPanel,
        serve: async () => undefined,
        beforeQuit() {},
        willQuit() {},
        liveLaunches: async () => [],
        endLaunch: async () => 'already-ended'
      },
      ipc: new RecordingIpcMain(),
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
    await started
    lock.launchAgain()

    expect(legacyPanel.calls).toEqual(['show'])
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
    const { factory, panel, lock, tray, legacy } = await cut0App({
      launch: uiStartPlanOf(['DwarfAI-Miners.exe', '--background'])
    })

    // Tray-only (S10.03): the tray and today's runtime, no window built.
    expect(factory.built).toEqual([])
    expect(tray.entries).toEqual(['open', 'quit', '—', 'stop-everything'])
    expect(legacy.counts.composed).toBe(1)
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

  it('[ADR-026] a start that fails records ui.start failed with its step and error class, never its message, before it exits with code 1', async () => {
    const { log, lifecycle } = await cut0App({ composeFails: true })

    expect(log.filter((entry) => entry.event === 'ui.start')).toEqual([
      {
        level: 'error',
        event: 'ui.start',
        subsystem: 'ui-main',
        outcome: 'failed',
        causeClass: 'legacy-compose',
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
  const cut1App = (options: Parameters<typeof cut0App>[0] = {}) =>
    cut0App({
      routes: RELEASE_ROUTES,
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

  it('[ADR-001] in cut 1 A-33 runs today’s reset first and then the Host saga through ResetFanout', async () => {
    const { ipc, host, legacy } = await cut1App({
      legacyAnswers: { 'metrics:reset': { outcome: 'reset' } }
    })
    host.handle('preferences.resetMetrics', () => ({ outcome: 'reset', epoch: 1 }))
    const answer = await ipc.handled.get('metrics:reset')?.(FROM_PANEL, {
      confirmed: 'yes',
      requestId: REQUEST
    })
    expect(answer).toEqual({ ok: true, value: { outcome: 'reset', epoch: 1 } })
    expect(legacy.events).toContain('legacy serve metrics:reset')
    expect(host.methods('ui')).toContain('preferences.resetMetrics')
  })

  it('[ADR-001] in cut 1 the retired rows reach neither today’s runtime nor the Host', async () => {
    const { ipc, host, legacy } = await cut1App()
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
    expect(legacy.events.filter((e) => e.startsWith('legacy serve'))).toEqual([])
    expect(host.received.length).toBe(before)
  })
})
