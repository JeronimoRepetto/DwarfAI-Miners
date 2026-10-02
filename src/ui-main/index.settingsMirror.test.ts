// layer: L2
import { afterEach, describe, expect, it } from 'vitest'
import type { HostPreferenceKey, HostPreferences, PreferenceSetParams } from '@dwarfai/contracts'
import { RecordingUiLog } from './hostLauncher/fakes/RecordingUiLog'
import { createHostClient, type HostClientService } from './host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from './host-client/testing/FakeHost'
import { FakeHostClientTimers } from './host-client/testing/FakeHostClientTimers'
import { startUiMain, type CreatedWindow, type UiMainDeps, type UiMainLifecycle } from './index'
import type { IpcMainRegistrar } from './ipc/router'
import { PRE_CUT_0_ROUTES } from './ipc/testing/preCutRoutes'
import { FakePanelWindowController } from './window/ports/fakes/FakePanelWindowController'
import { FakeSingleInstanceLock } from './window/ports/fakes/FakeSingleInstanceLock'
import { InMemoryUiPreferenceStore } from './window/ports/fakes/InMemoryUiPreferenceStore'

// L2 (17 §1): the composition root composes `SettingsMirrorBridge` (21 §3, cuts 1–3e; 05 R16) over the Host attach:
// the halves it is given are mirrored with `preferences.set` once the Host is attached and after each legacy write,
// until will-quit. Fakes: the Host (FakeHost behind the real HostClient), a test half and its legacy writes.

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

async function settle(rounds = 30): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

describe('UI main composes the settings mirror (21 §3)', () => {
  it('[ADR-001] the root mirrors a listed legacy preference into the Host on attach and after a legacy write, until will-quit', async () => {
    let hostPrefs: HostPreferences = {
      subagentDelegationOn: false,
      routingProfile: 'balanced',
      systemNotificationsOn: true,
      openCodePermissionsOn: false
    }
    const host = new FakeHost({
      capabilities: [...FAKE_HOST_CAPABILITIES, 'section:preferences', 'preferences.set']
    })
    host.board = [
      ...host.board,
      {
        section: 'preferences',
        data: {
          preferences: hostPrefs,
          secrets: [],
          secretBackend: 'os-keyring' as never,
          integrations: [],
          welcome: { due: false } as never
        }
      }
    ]
    host.handle('preferences.set', (params) => {
      const set = params as PreferenceSetParams
      hostPrefs = { ...hostPrefs, [set.key]: set.value }
      return hostPrefs
    })
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

    let legacyValue = false
    const listeners = new Set<(key: HostPreferenceKey) => void>()
    const saved = (key: HostPreferenceKey): void => {
      for (const listener of [...listeners]) listener(key)
    }
    const settingsMirror: UiMainDeps['settingsMirror'] = {
      legacy: {
        onWrite: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      },
      halves: [
        {
          keys: ['systemNotificationsOn'],
          readLegacy: () => Promise.resolve(legacyValue as never)
        }
      ]
    }

    let willQuit: () => void = () => {}
    const lifecycle: UiMainLifecycle = {
      quit: () => {},
      exit: () => {},
      whenReady: () => Promise.resolve(),
      onBeforeQuit: () => {},
      onWillQuit: (h) => (willQuit = h),
      onWindowAllClosed: () => {},
      onWindowCreated: (_h: (w: CreatedWindow) => void) => {}
    }
    const panel = new FakePanelWindowController({ visible: false })
    const legacyRuntime: UiMainDeps['legacyRuntime'] = {
      compose: async () => panel,
      serve: async () => undefined,
      beforeQuit: () => {},
      willQuit: () => {},
      liveLaunches: async () => [],
      endLaunch: async () => 'already-ended'
    }
    const ipc: IpcMainRegistrar = { handle: () => {}, on: () => {} }

    await startUiMain({
      lock: new FakeSingleInstanceLock(true),
      lifecycle,
      legacyRuntime,
      ipc,
      appEntry: 'file:///opt/DwarfAI/out/renderer/index.html',
      routes: PRE_CUT_0_ROUTES,
      uiPreferences: { store: new InMemoryUiPreferenceStore(), windows: () => [] },
      host: { client },
      settingsMirror
    })
    await settle()

    const sets = () =>
      host.received.filter((r) => r.method === 'preferences.set').map((r) => r.params)
    expect(sets()).toEqual([
      { key: 'systemNotificationsOn', value: false, requestId: expect.stringMatching(UUID_V7) }
    ])
    expect(hostPrefs.systemNotificationsOn).toBe(false)

    legacyValue = true
    saved('systemNotificationsOn')
    await settle()
    expect(sets()).toHaveLength(2)
    expect(sets()[1]).toEqual({
      key: 'systemNotificationsOn',
      value: true,
      requestId: expect.stringMatching(UUID_V7)
    })

    willQuit()
    saved('systemNotificationsOn')
    await settle()
    expect(sets()).toHaveLength(2)
  })
})
