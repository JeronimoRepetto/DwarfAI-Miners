// layer: L2
import { afterEach, describe, expect, it } from 'vitest'
import { RecordingUiLog } from './hostLauncher/fakes/RecordingUiLog'
import { createHostClient, type HostClientService } from './host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from './host-client/testing/FakeHost'
import { FakeHostClientTimers } from './host-client/testing/FakeHostClientTimers'
import { startUiMain, type UiMainDeps, type UiMainLifecycle } from './index'
import type { IpcMainRegistrar } from './ipc/router'
import { PRE_CUT_0_ROUTES } from './ipc/testing/preCutRoutes'
import { FakePanelWindowController } from './window/ports/fakes/FakePanelWindowController'
import { FakeSingleInstanceLock } from './window/ports/fakes/FakeSingleInstanceLock'
import { InMemoryUiPreferenceStore } from './window/ports/fakes/InMemoryUiPreferenceStore'

// L2 (17 §1; ADR-024 item 8; ADR-023 item 4 step 5; 14 §4.3 rule 4): the composition root hears the Reset metrics UI
// step on its Host attach, the snapshot's `meta.resetEpoch` at attach and the `ui.resetPreferences` frame after it, and
// acknowledges each on the window's `ui` connection. Fakes: the host launcher, the Host (FakeHost behind the real
// HostClient) and the UI preference store. The window family is served `legacy` here (no rebuilt Panel to compose);
// the reset is composed with the Host attach whatever the table serves, so the saga never waits on this UI.

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

describe('UI main start: the Reset metrics UI step on the Host attach (ADR-024 item 8)', () => {
  it('[ADR-024, ADR-023] a newer meta.resetEpoch at attach and a later ui.resetPreferences frame each reset the stores once and are acked on the ui connection', async () => {
    const host = new FakeHost({
      capabilities: [
        ...FAKE_HOST_CAPABILITIES,
        'frame:ui.resetPreferences',
        'ui.resetPreferences.ack'
      ]
    })
    host.board = [
      {
        section: 'meta',
        data: {
          hostVersion: '0.0.0-fake',
          state: 'ready',
          resetEpoch: 2,
          snapshotTail: 20,
          minesEverKnown: false
        }
      }
    ]
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
    const store = new InMemoryUiPreferenceStore()
    store.save('dockSide', 'left')
    store.save('resetEpochApplied', 1)
    const lifecycle: UiMainLifecycle = {
      quit: () => {},
      exit: () => {},
      whenReady: () => Promise.resolve(),
      onBeforeQuit: () => {},
      onWillQuit: () => {},
      onWindowAllClosed: () => {},
      onWindowCreated: () => {}
    }
    const legacyRuntime: UiMainDeps['legacyRuntime'] = {
      compose: async () => new FakePanelWindowController({ visible: false }),
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
      uiPreferences: { store, windows: () => [] },
      host: { client }
    })
    await settle()

    // At attach (S13.09): the stores are reset once for epoch 2, which is stored and acked.
    const acks = () =>
      host.received
        .filter((r) => r.method === 'ui.resetPreferences.ack')
        .map((r) => ({ role: r.role, params: r.params }))
    expect(store.load('dockSide')).toBe('right')
    expect(store.load('resetEpochApplied')).toBe(2)
    expect(acks()).toEqual([{ role: 'ui', params: { epoch: 2 } }])

    // The saga's `ui-prefs` step (S13.04): the frame for epoch 3 resets again and is acked.
    store.save('dockSide', 'left')
    host.publish('ui.resetPreferences', { epoch: 3 })
    await settle()
    expect(store.load('dockSide')).toBe('right')
    expect(store.load('resetEpochApplied')).toBe(3)
    expect(acks()).toEqual([
      { role: 'ui', params: { epoch: 2 } },
      { role: 'ui', params: { epoch: 3 } }
    ])
  })
})
