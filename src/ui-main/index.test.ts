// layer: L2
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from './diagnostics/ports/fakes/FakeClock'
import { FakeLogFiles } from './diagnostics/ports/fakes/FakeLogFiles'
import { createUiLogger, type UiLog, type UiLogEntry } from './diagnostics/uiLogger'
import {
  composeUiLocal,
  startUiMain as startUiMainOn,
  type CreatedWindow,
  type UiMainDeps,
  type UiMainLifecycle
} from './index'
import type { HostClientService } from './host-client/HostClient'
import type { IpcMainRegistrar } from './ipc/router'
import type { IpcSenderEvent } from './ipc/senderCheck'
import { FakePanelWindowController } from './window/ports/fakes/FakePanelWindowController'
import { FakeSingleInstanceLock } from './window/ports/fakes/FakeSingleInstanceLock'
import { JsonUiPreferenceStore, type UiPreferenceFs } from './window/adapters/JsonUiPreferenceStore'
import { createModeWindowRegistry } from './window/application/modeWindowRegistry'
import { defaultsOf } from './window/domain/uiPreferenceValues'
import {
  createInMemoryUiPreferenceStorage,
  InMemoryUiPreferenceStore
} from './window/ports/fakes/InMemoryUiPreferenceStore'
import { createPanelWindow } from './window/application/panelWindow'
import { FakeScreenAreaProvider } from './window/ports/fakes/FakeScreenAreaProvider'
import { FakeWindowFactory } from './window/ports/fakes/FakeWindowFactory'
import { PRE_CUT_0_ROUTES } from './ipc/testing/preCutRoutes'

// AMENDED for ISSUE-056 (was: `startUiMain` on the release's own table, which was the pre-cut table): these cases pin
// the root with the window family served `legacy`, today's Panel window included, as before the cut-0 switch and in a
// rollback build (21 §2.1); the cut-0 composition is pinned by index.cut0.test.ts.
const startUiMain = (deps: Parameters<typeof startUiMainOn>[0]) =>
  startUiMainOn({ routes: PRE_CUT_0_ROUTES, ...deps })

/**
 * The Electron composition root (05 §2.3, 16 §8.4): the single-instance lock is the first thing it
 * takes; only a process that holds it composes today's runtime and its Panel window (ADR-001, ADR-002
 * D3, PO #73).
 */
/** A HostClient that never attaches: what the composition root reads of it, and how often it was woken. */
function quietHostClient(): { client: HostClientService; wakes: () => number } {
  let wakes = 0
  const client = {
    ensureHost: () => new Promise<never>(() => {}),
    subscribe: () => () => {},
    state: () => ({ state: 'connecting' as const }),
    capabilities: () => [],
    onStateChange: () => () => {},
    hostFacts: () => null,
    wake: () => {
      wakes += 1
    },
    dispose: () => {}
  } as unknown as HostClientService
  return { client, wakes: () => wakes }
}

describe('ui-main composition root (05 §2.3)', () => {
  /** Records every lifecycle call and lets the test decide when the app is ready. */
  class RecordingLifecycle implements UiMainLifecycle {
    readonly calls: string[] = []
    readonly handlers = new Map<string, () => void>()
    private ready: () => void = () => {}
    private readonly readyPromise = new Promise<void>((resolve) => {
      this.ready = resolve
    })

    quit(): void {
      this.calls.push('quit')
    }
    exit(code: number): void {
      this.calls.push(`exit ${code}`)
    }
    whenReady(): Promise<void> {
      this.calls.push('whenReady')
      return this.readyPromise
    }
    onBeforeQuit(h: () => void): void {
      this.calls.push('onBeforeQuit')
      this.handlers.set('before-quit', h)
    }
    onWillQuit(h: () => void): void {
      this.calls.push('onWillQuit')
      this.handlers.set('will-quit', h)
    }
    onWindowAllClosed(h: () => void): void {
      this.calls.push('onWindowAllClosed')
      this.handlers.set('window-all-closed', h)
    }
    private windowCreated: (window: CreatedWindow) => void = () => {}
    onWindowCreated(h: (window: CreatedWindow) => void): void {
      this.calls.push('onWindowCreated')
      this.windowCreated = h
    }
    /** Electron created a window whose `webContents` has `id`; the answer closes it. */
    createWindow(id: number): { close(): void } {
      let closed: () => void = () => {}
      this.windowCreated({
        webContentsId: id,
        onClosed: (h) => {
          closed = h
        }
      })
      return { close: () => closed() }
    }
    becomeReady(): void {
      this.ready()
    }
  }

  /** Records the listeners the router registers on `ipcMain`, by wire name. */
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

  /** A stand-in for LegacyRuntimeRoute that counts compositions and quit teardowns. */
  function countingLegacyRuntime(outcome: 'composes' | 'fails' = 'composes') {
    const panel = new FakePanelWindowController({ visible: false })
    const counts = { composed: 0, beforeQuit: 0, willQuit: 0 }
    const served: [string, unknown][] = []
    const legacyRuntime: UiMainDeps['legacyRuntime'] = {
      async compose() {
        counts.composed += 1
        if (outcome === 'fails') throw new Error('today’s runtime could not start')
        return panel
      },
      async serve(channel, payload) {
        served.push([channel, payload])
        return channel === 'app:build' ? { version: '0.0.0-test' } : undefined
      },
      beforeQuit() {
        counts.beforeQuit += 1
      },
      willQuit() {
        counts.willQuit += 1
      },
      // AMENDED for ISSUE-056 (was: absent): the root reaches today's launched register for the A-N26 relay.
      liveLaunches: async () => [],
      endLaunch: async () => 'already-ended'
    }
    return { legacyRuntime, counts, panel, served }
  }

  const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
  const appEntry = APP_ENTRY
  const eventFrom = (id: number, url = APP_ENTRY): IpcSenderEvent => ({
    sender: { id },
    senderFrame: { url }
  })

  it('[ADR-001] when the single-instance lock is not acquired the root quits before composing the legacy runtime or any window', async () => {
    const lock = new FakeSingleInstanceLock(false)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime, counts, panel } = countingLegacyRuntime()

    await startUiMain({
      lock,
      lifecycle,
      legacyRuntime,
      ipc: new RecordingIpcMain(),
      appEntry
    })
    lifecycle.becomeReady()
    await Promise.resolve()

    expect(lock.acquireCalls).toBe(1)
    expect(lifecycle.calls).toEqual(['quit'])
    expect(counts.composed).toBe(0)
    expect(panel.calls).toEqual([])
    expect(lock.listenerCount).toBe(0)
  })

  it('[US-RES-008.AC01, S10.01] when the lock is acquired the root composes the legacy runtime once the app is ready and a second launch brings its Panel window forward', async () => {
    const lock = new FakeSingleInstanceLock(true)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime, counts, panel } = countingLegacyRuntime()

    const started = startUiMain({
      lock,
      lifecycle,
      legacyRuntime,
      ipc: new RecordingIpcMain(),
      appEntry
    })
    lock.launchAgain() // the lock is taken but the window does not exist yet (UC-033)
    expect(counts.composed).toBe(0)

    lifecycle.becomeReady()
    await started

    expect(counts.composed).toBe(1)
    expect(panel.calls).toEqual(['show'])
    lock.launchAgain()
    expect(panel.calls).toEqual(['show', 'show'])
    expect(lifecycle.calls).not.toContain('quit')
  })

  it('[ADR-001] the root hands the app quit to today’s teardown and keeps running with every window closed', async () => {
    const lock = new FakeSingleInstanceLock(true)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime, counts } = countingLegacyRuntime()

    const started = startUiMain({
      lock,
      lifecycle,
      legacyRuntime,
      ipc: new RecordingIpcMain(),
      appEntry
    })
    lifecycle.becomeReady()
    await started
    lifecycle.handlers.get('window-all-closed')?.()
    lifecycle.handlers.get('before-quit')?.()
    lifecycle.handlers.get('will-quit')?.()

    expect(counts).toEqual({ composed: 1, beforeQuit: 1, willQuit: 1 })
    expect(lifecycle.calls).not.toContain('quit')
    expect(lifecycle.calls.filter((call) => call.startsWith('exit'))).toEqual([])
  })

  it('[ADR-001] a start whose legacy runtime cannot be composed exits with code 1', async () => {
    const lock = new FakeSingleInstanceLock(true)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime } = countingLegacyRuntime('fails')

    const started = startUiMain({
      lock,
      lifecycle,
      legacyRuntime,
      ipc: new RecordingIpcMain(),
      appEntry
    })
    lifecycle.becomeReady()
    await started

    expect(lifecycle.calls).toContain('exit 1')
  })

  it('[ADR-001] the lock holder registers the router’s seam A listeners before composing, and a renderer call is served by today’s handler through LegacyRuntimeRoute', async () => {
    const lock = new FakeSingleInstanceLock(true)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime, counts, served } = countingLegacyRuntime()
    const ipc = new RecordingIpcMain()

    const started = startUiMain({ lock, lifecycle, legacyRuntime, ipc, appEntry })
    expect(counts.composed).toBe(0)
    expect(ipc.handled.has('app:build')).toBe(true)
    expect(ipc.listened.has('panel:openMine')).toBe(true)

    lifecycle.becomeReady()
    lifecycle.createWindow(1) // today's Panel window, created by the composition
    await started
    expect(await ipc.handled.get('app:build')?.(eventFrom(1), undefined)).toEqual({
      version: '0.0.0-test'
    })
    expect(served).toEqual([['app:build', undefined]])
  })

  it('[ADR-019] the root registers each window it creates as a mode window: its app entry is served, a window it never created or one that closed is ignored', async () => {
    const lock = new FakeSingleInstanceLock(true)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime, served } = countingLegacyRuntime()
    const ipc = new RecordingIpcMain()
    const rejected = {
      ok: false,
      error: { code: 'SENDER_REJECTED', message: expect.any(String), retryable: false }
    }

    const started = startUiMain({ lock, lifecycle, legacyRuntime, ipc, appEntry })
    // Registered before anything is composed, so the first window the composition creates is known at once.
    expect(lifecycle.calls.indexOf('onWindowCreated')).toBeLessThan(
      lifecycle.calls.indexOf('whenReady')
    )
    lifecycle.becomeReady()
    const panel = lifecycle.createWindow(4)
    await started
    const build = ipc.handled.get('app:build')

    expect(await build?.(eventFrom(4), undefined)).toEqual({ version: '0.0.0-test' })
    expect(await build?.(eventFrom(5), undefined)).toEqual(rejected)
    expect(await build?.(eventFrom(4, 'https://attacker.example/'), undefined)).toEqual(rejected)
    panel.close()
    expect(await build?.(eventFrom(4), undefined)).toEqual(rejected)
    expect(served).toEqual([['app:build', undefined]])
  })

  it('[FM-109] an OS resume from sleep after the app is ready wakes the Host client, which pings at once', async () => {
    class ResumingLifecycle extends RecordingLifecycle {
      resume: () => void = () => {}
      onResume(h: () => void): void {
        this.calls.push('onResume')
        this.resume = h
      }
    }
    const lifecycle = new ResumingLifecycle()
    const host = quietHostClient()
    const started = startUiMain({
      lock: new FakeSingleInstanceLock(true),
      lifecycle,
      legacyRuntime: countingLegacyRuntime().legacyRuntime,
      ipc: new RecordingIpcMain(),
      appEntry,
      host: { client: host.client }
    })
    lifecycle.becomeReady()
    await started

    expect(lifecycle.calls).toContain('onResume')
    lifecycle.resume()
    expect(host.wakes()).toBe(1)
  })

  it('[ADR-001] a process that does not hold the single-instance lock registers no seam A listener', async () => {
    const ipc = new RecordingIpcMain()
    const { legacyRuntime } = countingLegacyRuntime()

    await startUiMain({
      lock: new FakeSingleInstanceLock(false),
      lifecycle: new RecordingLifecycle(),
      legacyRuntime,
      ipc,
      appEntry
    })

    expect([...ipc.handled.keys(), ...ipc.listened.keys()]).toEqual([])
  })

  it('[ADR-001] the Panel window rows join the ui-local target but stay legacy until the cut-0 switch: no second Panel window, no preference write', async () => {
    const lock = new FakeSingleInstanceLock(true)
    const lifecycle = new RecordingLifecycle()
    const { legacyRuntime, served } = countingLegacyRuntime()
    const ipc = new RecordingIpcMain()
    const storage = createInMemoryUiPreferenceStorage()
    const windows = new FakeWindowFactory()
    const displayHandlers: Array<() => void> = []
    let composed: ReturnType<typeof createPanelWindow> | undefined
    const panelWindow: UiMainDeps['panelWindow'] = () =>
      (composed = createPanelWindow({
        windows,
        surface: {
          applyZoom: (factor) => factor,
          bounds: () => windows.panel().bounds ?? { x: 0, y: 0, width: 0, height: 0 },
          setAlwaysOnTop: (on) => on,
          isAlwaysOnTop: () => false,
          raise: () => undefined,
          isMinimized: () => false,
          // AMENDED for ISSUE-056 (was: absent): the visibility read-back of the 2026-10-01 amendment.
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
        store: new InMemoryUiPreferenceStore(storage),
        floor: 32,
        onDisplaysChanged: (h) => displayHandlers.push(h)
      }))

    const started = startUiMain({ lock, lifecycle, legacyRuntime, ipc, appEntry, panelWindow })
    lifecycle.becomeReady()
    lifecycle.createWindow(1) // today's Panel window, created by the composition
    await started

    // The rows are `legacy` in the route table (21 §1 item 4): today's runtime serves them, the rebuilt Panel nothing.
    await ipc.handled.get('panel:setAlwaysOnTop')?.(eventFrom(1), false)
    await ipc.handled.get('panel:layout:set')?.(eventFrom(1), { mineOpen: true, dockOpen: false })
    ipc.listened.get('panel:hide')?.(eventFrom(1), undefined)
    for (const h of displayHandlers) h()
    expect(served.map(([channel]) => channel)).toEqual([
      'panel:setAlwaysOnTop',
      'panel:layout:set',
      'panel:hide'
    ])
    expect(windows.built, 'no second Panel window').toEqual([])
    expect(storage.stored, 'no preference write').toEqual({})

    // The part is composed and joins the one ui-local target, ready for the cut-0 switch (ISSUE-056).
    expect(composed).toBeDefined()
    const uiLocal = composeUiLocal({
      panelWindow: composed,
      modeWindows: createModeWindowRegistry()
    })
    expect(await uiLocal?.serve('panel:layout:get', undefined, eventFrom(1))).toEqual({
      edge: 'right',
      mineOpen: false,
      dockOpen: false
    })
  })

  describe('the ui-local route target (ADR-001 item 3; 21 §1 item 1)', () => {
    class RecordingUiLog implements UiLog {
      readonly entries: UiLogEntry[] = []
      record(entry: UiLogEntry): void {
        this.entries.push(entry)
      }
    }
    const registeredPanel = () => {
      const modeWindows = createModeWindowRegistry()
      modeWindows.register(3)
      return modeWindows
    }

    it('[ADR-001] the preference rows and A-N30 are served by one ui-local target, each by its own part', async () => {
      const uiLog = new RecordingUiLog()
      const uiLocal = composeUiLocal({
        uiPreferences: { store: new InMemoryUiPreferenceStore(), windows: () => [] },
        uiLog,
        modeWindows: registeredPanel(),
        clock: new FakeClock(0)
      })
      expect(uiLocal).toBeDefined()
      expect(await uiLocal?.serve('audio:preferences:get', undefined, eventFrom(3))).toEqual(
        defaultsOf('audio')
      )
      expect(
        await uiLocal?.serve('diag:renderer:report', { event: 'renderer.error' }, eventFrom(3))
      ).toBeUndefined()
      expect(uiLog.entries).toEqual([
        { level: 'error', event: 'renderer.error', subsystem: 'window', msg: 'panel' }
      ])
      expect(await uiLocal?.serve('panel:hide', undefined, eventFrom(3))).toEqual({
        ok: false,
        error: { code: 'METHOD_NOT_FOUND', message: 'no route for panel:hide', retryable: false }
      })
    })

    it('[ADR-001] only the parts whose dependencies are given join the target, and with none there is no target', async () => {
      const onlyDiagnostics = composeUiLocal({
        uiLog: new RecordingUiLog(),
        modeWindows: registeredPanel(),
        clock: new FakeClock(0)
      })
      expect(
        await onlyDiagnostics?.serve('audio:preferences:get', undefined, eventFrom(3))
      ).toEqual({
        ok: false,
        error: {
          code: 'METHOD_NOT_FOUND',
          message: 'no route for audio:preferences:get',
          retryable: false
        }
      })
      expect(composeUiLocal({ modeWindows: registeredPanel() })).toBeUndefined()
    })

    it('[ADR-001] the Host connection rows join the ui-local target with the Host client, and A-N33 is not one of them', async () => {
      const uiLocal = composeUiLocal({
        hostConnection: quietHostClient().client,
        modeWindows: registeredPanel()
      })
      expect(await uiLocal?.serve('host:connection:get', undefined, eventFrom(3))).toEqual({
        state: 'connecting'
      })
      expect(
        await uiLocal?.serve('host:connection:confirm-restart', undefined, eventFrom(3))
      ).toMatchObject({ ok: false, error: { code: 'METHOD_NOT_FOUND', retryable: false } })
    })

    it('[ADR-026] the UI preference store records reach the ui segments through the UI record rules', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dwarfai-uiprefs-log-'))
      try {
        const files = new FakeLogFiles()
        const logDir = join('/', 'user-data', 'logs')
        const uiLog = createUiLogger({
          files,
          logDir,
          clock: new FakeClock(Date.parse('2026-10-01T09:00:00.000Z')),
          appVersion: '0.20.0',
          pid: 7,
          level: 'info'
        })
        const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
        const failing: UiPreferenceFs = {
          readFileSync: () => {
            throw denied
          },
          writeFileSync: () => {
            throw denied
          },
          renameSync: () => {},
          mkdirSync: () => undefined
        }
        const store = new JsonUiPreferenceStore({ dir, fs: failing, log: (r) => uiLog.record(r) })
        store.load('launchView')
        // A failed save is logged and rethrown for the use case to answer (ISSUE-048).
        expect(() => store.save('audio', defaultsOf('audio'))).toThrow('denied')
        await uiLog.flush()

        const lines = (files.textOf(join(logDir, 'ui-000001.jsonl')) ?? '')
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>)
        expect(lines).toEqual([
          expect.objectContaining({
            proc: 'ui',
            level: 'warn',
            event: 'uiprefs.corrupt',
            subsystem: 'window',
            msg: 'launchView',
            errCode: 'EACCES'
          }),
          expect.objectContaining({
            proc: 'ui',
            event: 'uiprefs.write-failed',
            msg: 'audio',
            errCode: 'EACCES'
          })
        ])
        expect(uiLog.counters()).toMatchObject({ refused: 0, failed: 0 })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
