import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@dwarfai/contracts'
import { FakeHostLink } from './fakes/FakeHostLink'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import type { EnsureHostResult } from './launcher'
import { createUpgradingLauncher } from './upgradingLauncher'

// L3 (17 §1.3): the host launcher with the ADR-002 D8 handshake after it, over its ports — a scripted launcher and a
// scripted Host link (UC-026; 07 S12.B01–S12.B03). The app's composition of it is composeHostClient.contract.test.ts.

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

function world(options: { launched?: EnsureHostResult; links: FakeHostLink[] }) {
  const attaches: number[] = []
  const reattached: number[] = []
  let next = 0
  const launcher = createUpgradingLauncher({
    launcher: { ensureHostRunning: () => Promise.resolve(options.launched ?? 'attached') },
    flow: {
      build: { protocolVersion: PROTOCOL_VERSION, endpointGeneration: 1, appVersion: '0.21.0' },
      attach: () => {
        attaches.push(1)
        const link = options.links[next]
        next += 1
        return Promise.resolve(
          link === undefined ? { kind: 'unreachable' } : { kind: 'attached', link }
        )
      },
      prepareTarget: () =>
        Promise.resolve({ ok: true, targetVersion: '0.21.0', targetDir: '/data/j/host/0.21.0' }),
      confirm: () => Promise.resolve(false),
      newRequestId: () => REQUEST_ID,
      log: new RecordingUiLog()
    },
    reattach: () => reattached.push(1)
  })
  return { launcher, attaches, reattached }
}

describe('the host launcher with the D8 handshake after it (ADR-002 D8)', () => {
  it('[ADR-002, S12.B03] a launch that failed is answered as it is and no handshake runs', async () => {
    const w = world({ launched: { unavailable: 'spawn-failed' }, links: [] })

    expect(await w.launcher.ensureHostRunning()).toEqual({ unavailable: 'spawn-failed' })
    expect(w.attaches).toEqual([])
  })

  it('[ADR-002, FM-131] while the compat handshake waits for the drain, another attach is answered the same and asks no second upgrade', async () => {
    const old = new FakeHostLink({ protocolVersion: PROTOCOL_VERSION - 1 })
    const w = world({ links: [old] })

    expect(await w.launcher.ensureHostRunning()).toBe('attached')
    await settle()
    expect(await w.launcher.ensureHostRunning()).toBe('attached')
    await settle()

    expect(w.attaches).toHaveLength(1)
    expect(old.calls.map((call) => call.method)).toEqual(['host.upgrade.request'])
    expect(w.reattached).toEqual([])
    old.hostClosed('upgrade')
    await settle()
    expect(w.reattached).toEqual([1])
  })

  it('[ADR-002, FM-133] dispose closes the link the handshake holds on a newer Host and nothing is attached again after it', async () => {
    const newer = new FakeHostLink({ protocolVersion: PROTOCOL_VERSION + 1 })
    const w = world({ links: [newer] })

    expect(await w.launcher.ensureHostRunning()).toEqual({ unavailable: 'incompatible' })
    w.launcher.dispose()
    await settle()

    expect(newer.closedByClient).toBe(true)
    expect(newer.calls).toEqual([])
    expect(w.reattached).toEqual([])
  })
})
