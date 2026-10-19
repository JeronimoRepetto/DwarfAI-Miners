// layer: L2
import { afterEach, describe, expect, it } from 'vitest'
import type { SnapshotChunk } from '@dwarfai/contracts'
import { RecordingUiLog } from './hostLauncher/fakes/RecordingUiLog'
import type { EnsureHostResult } from './hostLauncher/launcher'
import { createHostClient, type HostClientService } from './host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from './host-client/testing/FakeHost'
import { FakeHostClientTimers } from './host-client/testing/FakeHostClientTimers'
import { startUiMain as startUiMainOn, type CreatedWindow, type UiMainLifecycle } from './index'
import type { IpcMainRegistrar } from './ipc/router'
import type { HostBoardState } from './window/application/reopen'
import { FakeSingleInstanceLock } from './window/ports/fakes/FakeSingleInstanceLock'
import { InMemoryUiPreferenceStore } from './window/ports/fakes/InMemoryUiPreferenceStore'
import type { UiPreferenceStoreKey } from './window/ports/uiPreferenceStore'
import { fakeRebuiltPanel } from './window/testing/fakeRebuiltPanel'

// AMENDED for ISSUE-056 (was: `startUiMain` on the release's own table, which was the pre-cut table): these cases pinned
// the root with the window family served `legacy`, today's Panel window included. AMENDED for ISSUE-243 (was: that
// pre-cut table, the first paint being today's runtime composing its Panel window): today's runtime left the tree (21
// §2 cut 5), so the release's own table runs with the rebuilt Panel, whose window is the first paint.
const startUiMain = (deps: Parameters<typeof startUiMainOn>[0]) => startUiMainOn(deps)

// L2 (17 §1; US-RES-003.AC07, UI-main half; UC-024 "remembered layout and rehydrated sessions arrive together";
// 14 §4.2): the composition root starts the Host attach beside the launch-view read, never holds the window back
// for it, and the board it keeps changes only when a whole snapshot arrived. Fakes: the host launcher, the Host
// (FakeHost behind the real HostClient) and the UI preference store.

const clients: HostClientService[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
})

async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

const chunk = (section: 'meta' | 'mines' | 'dwarfs', id: string): SnapshotChunk =>
  section === 'meta'
    ? {
        section,
        data: {
          hostVersion: id,
          state: 'ready',
          resetEpoch: 0,
          snapshotTail: 20,
          minesEverKnown: true
        }
      }
    : ({ section, data: [{ id }] } as never)

describe('UI main start: launch view and Host attach together (US-RES-003.AC07)', () => {
  it('[US-RES-003.AC07] the launch view is read before the first paint while the attach runs, and the snapshot is applied only after its last page, with no empty board in between', async () => {
    const order: string[] = []
    const host = new FakeHost({
      capabilities: [...FAKE_HOST_CAPABILITIES, 'section:mines', 'section:dwarfs']
    })
    host.board = [chunk('meta', 'one'), chunk('mines', 'm1'), chunk('dwarfs', 'd1')]
    let releaseLauncher: (result: EnsureHostResult) => void = () => {}
    const client = createHostClient({
      launcher: {
        ensureHostRunning: () => {
          order.push('attach started')
          return new Promise((resolve) => (releaseLauncher = resolve))
        }
      },
      connect: host.connect,
      readToken: () => Promise.resolve(host.token),
      protocolVersion: 1,
      client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
      timers: new FakeHostClientTimers(),
      log: new RecordingUiLog(),
      hungHost: { endHungHost: () => Promise.resolve({ outcome: 'identity-missing' }) }
    })
    clients.push(client)

    class OrderedStore extends InMemoryUiPreferenceStore {
      override load<K extends UiPreferenceStoreKey>(k: K) {
        order.push(`load ${k}`)
        return super.load(k)
      }
    }
    const store = new OrderedStore()
    store.storage.stored.launchView = { area: 'mines', mineId: 'm1' }
    const lifecycle: UiMainLifecycle = {
      quit: () => {},
      exit: () => {},
      whenReady: () => Promise.resolve(),
      onBeforeQuit: () => {},
      onWillQuit: () => {},
      onWindowAllClosed: () => {},
      onWindowCreated: (_h: (w: CreatedWindow) => void) => {}
    }
    const ipc: IpcMainRegistrar = { handle: () => {}, on: () => {} }

    const started = await startUiMain({
      lock: new FakeSingleInstanceLock(true),
      lifecycle,
      ipc,
      // The first paint: the rebuilt Panel's window, built hidden with its page loading once the app is ready.
      panelWindow: fakeRebuiltPanel(undefined, () => order.push('first paint')),
      appEntry: 'file:///opt/DwarfAI/out/renderer/index.html',
      uiPreferences: { store, windows: () => [] },
      host: { client }
    })

    // The window painted from the remembered launch view; the attach is still running.
    expect(order).toEqual(['load launchView', 'attach started', 'first paint'])
    const reopen = started?.reopen
    expect(reopen?.launchView).toEqual({ area: 'mines', mineId: 'm1' })
    expect(reopen?.board()).toBeNull()

    // Every page of the first snapshot: the board stays as it was (nothing yet) until the last one.
    const seen: Array<HostBoardState | null> = []
    host.beforePage = () => seen.push(reopen?.board() ?? null)
    releaseLauncher('attached')
    await settle()
    expect(seen).toEqual([null, null, null])
    const first = reopen?.board()
    expect(first?.snapshot.chunks).toEqual(host.board)

    // A re-snapshot: the previous whole board stays until the new one's last page, never an empty one.
    seen.length = 0
    host.board = [chunk('meta', 'two'), chunk('mines', 'm1'), chunk('dwarfs', 'd2')]
    host.publish('resync-required', { reason: 'metrics-reset' })
    await settle()
    expect(seen).toHaveLength(3)
    for (const board of seen) expect(board?.snapshot.chunks).toEqual(first?.snapshot.chunks)
    expect(reopen?.board()?.snapshot.chunks).toEqual(host.board)
  })
})
