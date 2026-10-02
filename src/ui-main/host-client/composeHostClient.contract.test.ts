// layer: L6
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@dwarfai/contracts'
import { RecordingUiLog } from '../hostLauncher/fakes/RecordingUiLog'
import { createHostLinkOpener } from '../hostLauncher/hostLink'
import type { EnsureHostResult } from '../hostLauncher/launcher'
import type { HostConnection } from '../window/ports/hostClient'
import { composeHostClient } from './composeHostClient'
import type { ClosingReason } from './channel'
import type { HostClientService } from './HostClient'
import { FakeHost } from './testing/FakeHost'
import { FakeHostClientTimers } from './testing/FakeHostClientTimers'

// L6 (17 §1.6; ADR-002 D8; UC-026; 07 S12.B01–S12.B03): the app's Host attach as UI main composes it — the real
// HostClient over the host launcher with the D8 upgrade handshake (upgradeFlow.ts) on the real `ui` link (hostLink.ts)
// — against FakeHost speaking the seam-B frames over in-memory duplex pairs. The launcher and this UI's versioned copy
// are fakes: the launcher "spawns" a Host by bringing FakeHost back as this build. TC-032-01 and TC-032-04 through the
// app's composition (ISSUE-057 TC-057-02/03 rehearse the same paths across two real builds).

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const TARGET_DIR = '/data/j/dwarfai/host/0.21.0'
const UI_VERSION = '0.21.0'

const clients: HostClientService[] = []
const folders: string[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

async function settle(rounds = 40): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Turns the event loop until `done` holds, at most `rounds` times: the handshake's link reads its token file (real
 * I/O, ADR-003 item 4), which no fixed number of turns bounds. The assertion after it says what was expected.
 */
async function until(done: () => boolean, rounds = 5_000): Promise<void> {
  for (let round = 0; round < rounds && !done(); round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

const connected = (client: HostClientService) => (): boolean => client.state().state === 'connected'

/**
 * A running Host of another build (`hostProtocolVersion`) and the app's composition over it. The fake launcher attaches
 * while that Host listens; once it closed, it starts this build's Host (FakeHost back with this UI's protocol version).
 */
function world(hostProtocolVersion: number) {
  const host = new FakeHost({ protocolVersion: hostProtocolVersion, hostVersion: '0.20.0' })
  const timers = new FakeHostClientTimers()
  const folder = mkdtempSync(path.join(tmpdir(), 'dwarfai-compose-d8-'))
  folders.push(folder)
  const tokenFile = path.join(folder, 'ui.token')
  writeFileSync(tokenFile, host.token)
  const launches: EnsureHostResult[] = []
  const prepared: number[] = []
  let closed = false
  /** The running Host exits cleanly (ADR-002 D7): `host.closing {reason}`, then nothing listens. */
  const closeCleanly = (reason: 'stop-all' | 'upgrade'): void => {
    closed = true
    host.closeCleanly(reason)
  }
  const launcher = {
    ensureHostRunning: (): Promise<EnsureHostResult> => {
      let result: EnsureHostResult = 'attached'
      if (closed) {
        // The Host that was running closed: this build's own Host is started from its versioned copy.
        closed = false
        host.restart()
        host.protocolVersion = PROTOCOL_VERSION
        host.hostVersion = UI_VERSION
        result = 'spawned'
      }
      launches.push(result)
      return Promise.resolve(result)
    }
  }
  const client = composeHostClient({
    launcher,
    upgrade: {
      attach: createHostLinkOpener({
        connect: host.connect,
        tokenFile,
        protocolVersion: PROTOCOL_VERSION,
        client: { appVersion: UI_VERSION, buildId: 'test', pid: 4242 },
        after: timers.after
      }),
      prepareTarget: () => {
        prepared.push(1)
        return Promise.resolve({ ok: true, targetVersion: UI_VERSION, targetDir: TARGET_DIR })
      }
    },
    newRequestId: () => REQUEST_ID,
    connect: host.connect,
    readToken: () => Promise.resolve(host.token),
    protocolVersion: PROTOCOL_VERSION,
    client: { appVersion: UI_VERSION, buildId: 'test', pid: 4242 },
    timers,
    log: new RecordingUiLog(),
    hungHost: { endHungHost: () => Promise.resolve({ outcome: 'identity-missing' }) }
  })
  clients.push(client)
  const states: HostConnection[] = []
  client.onStateChange((state) => states.push(state))
  const closings: ClosingReason[] = []
  client.onClosing((reason) => closings.push(reason))
  return { host, client, states, closings, launches, prepared, closeCleanly }
}

describe("the app's Host attach runs the ADR-002 D8 upgrade handshake (UC-026)", () => {
  it('[ADR-002, S12.B01] a Host of the same protocolVersion is attached normally and is sent nothing', async () => {
    const w = world(PROTOCOL_VERSION)

    expect(await w.client.ensureHost()).toBe('available')
    await until(() => w.host.liveConnections('ui') === 0)
    await settle()

    expect(w.client.state()).toEqual({ state: 'connected', hostVersion: '0.20.0', compat: false })
    expect(w.host.methods()).not.toContain('host.upgrade.request')
    expect(w.host.methods()).not.toContain('host.shutdown')
    // The handshake said `hello` first on its own `ui` link and closed it once it decided: only the notifier stays.
    expect(w.host.hellos.map((hello) => hello.role)).toEqual(['ui', 'notifier'])
    expect(w.host.liveConnections('ui')).toBe(0)
    expect(w.host.liveConnections('notifier')).toBe(1)
  })

  it('[ADR-002, FM-131, S12.B02, S12.13, TC-032-01] an older running Host is attached in compat mode, asked to upgrade to this build, and once it drained the new Host is started and attached normally, never as a lost connection', async () => {
    const w = world(PROTOCOL_VERSION - 1)
    const upgradeRequests: unknown[] = []
    w.host.handle('host.upgrade.request', (params) => {
      upgradeRequests.push(params)
      return { state: 'upgrade-pending' }
    })

    expect(await w.client.ensureHost()).toBe('available')
    await until(() => w.prepared.length === 1 && w.host.methods().includes('host.upgrade.request'))
    // Compat mode while the old Host drains (D8 item 2): the board is served, the upgrade is asked once.
    expect(w.client.state()).toEqual({ state: 'connected', hostVersion: '0.20.0', compat: true })
    expect(upgradeRequests).toEqual([
      { targetVersion: UI_VERSION, targetDir: TARGET_DIR, requestId: REQUEST_ID }
    ])
    expect(w.prepared).toHaveLength(1)

    // Nothing is open: the old Host drains and closes for the upgrade (S12.14, S12.16).
    w.closeCleanly('upgrade')
    await until(() => w.launches.includes('spawned') && connected(w.client)())

    expect(w.client.state()).toEqual({ state: 'connected', hostVersion: UI_VERSION, compat: false })
    expect(w.launches).toContain('spawned')
    expect(w.closings).toEqual(['upgrade'])
    // DwarfAI's own stop: never `reconnecting` or `unavailable`, so nothing raises the PO #62 toast.
    expect(w.states.map((state) => state.state)).not.toContain('reconnecting')
    expect(w.states.map((state) => state.state)).not.toContain('unavailable')
    expect(upgradeRequests).toHaveLength(1)
  })

  it('[ADR-002, FM-133, S12.B03, TC-032-04] a newer running Host is reported incompatible and never sent host.upgrade.request; once the app’s Stop everything and quit stopped it, this build starts its own Host and attaches, without quitting', async () => {
    const w = world(PROTOCOL_VERSION + 1)
    w.host.handle('host.shutdown', () => {
      setImmediate(() => w.closeCleanly('stop-all'))
      return { mode: 'stop-all', outcome: { ended: [], failed: [] } }
    })

    expect(await w.client.ensureHost()).toEqual({ unavailable: 'incompatible' })
    await settle()
    expect(w.client.state()).toEqual({ state: 'unavailable', reason: 'incompatible' })
    expect(w.host.methods()).not.toContain('host.upgrade.request')
    expect(w.host.methods()).not.toContain('host.shutdown')

    // The only offer, Stop everything and quit, as the app's flow sends it (stopEverything.ts on withUiConnection).
    await w.client.withUiConnection((c) =>
      c.call('host.shutdown', { mode: 'stop-all', requestId: REQUEST_ID })
    )
    await until(() => w.launches.includes('spawned') && connected(w.client)())

    expect(w.host.methods().filter((method) => method !== 'ping')).toEqual(['host.shutdown'])
    expect(w.launches).toContain('spawned')
    expect(w.client.state()).toEqual({ state: 'connected', hostVersion: UI_VERSION, compat: false })
    // D8 item 5: the older UI starts its own Host; the tray process does not exit with the newer one.
    expect(w.closings).toEqual([])
  })
})
