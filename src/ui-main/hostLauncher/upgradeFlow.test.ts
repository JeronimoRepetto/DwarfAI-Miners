import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type DwarfId } from '@dwarfai/contracts'
import { FakeHostLink } from './fakes/FakeHostLink'
import { RecordingUiLog } from './fakes/RecordingUiLog'
import type { EnsureHostResult } from './launcher'
import {
  runUpgradeFlow,
  type HostAttach,
  type UpgradeFlowDeps,
  type UpgradeFlowState
} from './upgradeFlow'

// L3 (17 §1.3): the UI half of the ADR-002 D8 handshake over its ports — a scripted Host link, a
// recorded confirmation and a recorded ensureHostRunning (UC-026; 07 S12.B01–S12.B03, S12.B16;
// 13 FM-131…FM-133). TC-032-01 (UI half), TC-032-03, TC-032-04.

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const TARGET_DIR = '/data/j/dwarfai/host/0.21.0'
const FAILED_DWARF = '01890a5d-ac96-774b-bcce-b302099a8062' as DwarfId

interface World {
  deps: UpgradeFlowDeps
  states: UpgradeFlowState[]
  attaches: Array<'current' | 'previous'>
  questions: string[]
  ensured: number
  prepared: number
}

function world(options: {
  first: HostAttach
  previous?: HostAttach
  confirm?: boolean
  protocolVersion?: number
  endpointGeneration?: number
}): World {
  const w: World = {
    deps: undefined as unknown as UpgradeFlowDeps,
    states: [],
    attaches: [],
    questions: [],
    ensured: 0,
    prepared: 0
  }
  w.deps = {
    build: {
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
      endpointGeneration: options.endpointGeneration ?? 1,
      appVersion: '0.21.0'
    },
    attach: (generation) => {
      w.attaches.push(generation)
      return Promise.resolve(
        generation === 'current' ? options.first : (options.previous ?? { kind: 'unreachable' })
      )
    },
    prepareTarget: () => {
      w.prepared += 1
      return Promise.resolve({ ok: true, targetVersion: '0.21.0', targetDir: TARGET_DIR })
    },
    ensureHostRunning: (): Promise<EnsureHostResult> => {
      w.ensured += 1
      return Promise.resolve('spawned')
    },
    confirm: (question) => {
      w.questions.push(question)
      return Promise.resolve(options.confirm ?? false)
    },
    report: (state) => w.states.push(state),
    newRequestId: () => REQUEST_ID,
    log: new RecordingUiLog()
  }
  return w
}

const attached = (link: FakeHostLink): HostAttach => ({ kind: 'attached', link })

/** Lets the flow reach its next wait. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('the UI half of the upgrade handshake (ADR-002 D8; UC-026)', () => {
  it('[ADR-002] the same protocolVersion attaches normally and sends nothing', async () => {
    const link = new FakeHostLink({ protocolVersion: PROTOCOL_VERSION })
    const w = world({ first: attached(link) })

    const result = await runUpgradeFlow(w.deps)

    expect(result).toEqual({ kind: 'attached', link })
    expect(link.calls).toEqual([])
    expect(w.states).toEqual([{ phase: 'attached', compat: false, hostVersion: '0.20.0' }])
    expect(w.prepared + w.ensured).toBe(0)
  })

  it('[ADR-002, FM-131, S12.13] a newer UI attaches in compat mode, requests the upgrade for its versioned copy and starts the new Host once the old one closed for the upgrade, with no lost connection reported', async () => {
    const link = new FakeHostLink({ protocolVersion: PROTOCOL_VERSION - 1 })
    const w = world({ first: attached(link) })

    const running = runUpgradeFlow(w.deps)
    await settle()
    // Requested and waiting for the drain: nothing is started while the old Host holds the endpoint.
    expect(link.calls).toEqual([
      {
        method: 'host.upgrade.request',
        params: { targetVersion: '0.21.0', targetDir: TARGET_DIR, requestId: REQUEST_ID }
      }
    ])
    expect(w.ensured).toBe(0)
    link.hostClosed('upgrade')
    const result = await running

    expect(result).toEqual({ kind: 'swapped', ensure: 'spawned' })
    expect(w.prepared).toBe(1)
    expect(w.ensured).toBe(1)
    expect(w.states).toEqual([
      { phase: 'compat', hostVersion: '0.20.0' },
      { phase: 'restarting', reason: 'upgrade' }
    ])
    expect(w.questions).toEqual([])
  })

  it('[ADR-002, FM-131] a Host that does not advertise host.upgrade.request is never sent it and the UI stays in compat mode', async () => {
    const link = new FakeHostLink({
      protocolVersion: PROTOCOL_VERSION - 1,
      capabilities: ['ping', 'host.shutdown']
    })
    const w = world({ first: attached(link) })

    const running = runUpgradeFlow(w.deps)
    await settle()
    expect(link.calls).toEqual([])
    link.hostClosed(null)

    expect(await running).toEqual({ kind: 'compat', link, upgrade: 'not-advertised' })
    expect(w.states).toEqual([{ phase: 'compat', hostVersion: '0.20.0' }])
    expect(w.prepared + w.ensured).toBe(0)
  })

  it('[ADR-002, FM-132] a different generation shows the blocking notice and sends host.shutdown upgrade-drain only after confirmation', async () => {
    // Declined: nothing is sent and the old Host keeps its sessions.
    const declined = world({ first: { kind: 'refused', code: 'INCOMPATIBLE_GENERATION' } })
    expect(await runUpgradeFlow(declined.deps)).toEqual({ kind: 'declined' })
    expect(declined.attaches).toEqual(['current'])
    expect(declined.states).toEqual([{ phase: 'generation-restart' }])
    expect(declined.questions).toEqual(['generation-restart'])
    expect(declined.ensured).toBe(0)

    // Confirmed: speak the previous generation, ask the generation-stable drain, then start anew.
    const previous = new FakeHostLink({ protocolVersion: PROTOCOL_VERSION - 1 })
    const w = world({
      first: { kind: 'refused', code: 'INCOMPATIBLE_GENERATION' },
      previous: attached(previous),
      confirm: true
    })
    const running = runUpgradeFlow(w.deps)
    await settle()
    expect(previous.calls).toEqual([
      { method: 'host.shutdown', params: { mode: 'upgrade-drain', requestId: REQUEST_ID } }
    ])
    expect(w.ensured).toBe(0)
    previous.hostClosed('upgrade')

    expect(await running).toEqual({ kind: 'swapped', ensure: 'spawned' })
    expect(w.attaches).toEqual(['current', 'previous'])
    expect(w.questions).toEqual(['generation-restart'])
    expect(w.states).toEqual([
      { phase: 'generation-restart' },
      { phase: 'restarting', reason: 'upgrade' }
    ])
  })

  it('[ADR-002, FM-133] an older UI never sends host.upgrade.request, offers only stop-all and, once the Host has exited, starts its own Host', async () => {
    // Declined: nothing at all is sent.
    const declinedLink = new FakeHostLink({ protocolVersion: PROTOCOL_VERSION + 1 })
    const declined = world({ first: attached(declinedLink) })
    const declining = runUpgradeFlow(declined.deps)
    await settle()
    expect(declinedLink.calls).toEqual([])
    declinedLink.hostClosed(null)
    expect(await declining).toEqual({ kind: 'declined' })
    expect(declined.questions).toEqual(['stop-everything'])

    const link = new FakeHostLink({ protocolVersion: PROTOCOL_VERSION + 1, hostVersion: '0.22.0' })
    const w = world({ first: attached(link), confirm: true })
    const running = runUpgradeFlow(w.deps)
    await settle()
    expect(link.calls).toEqual([
      { method: 'host.shutdown', params: { mode: 'stop-all', requestId: REQUEST_ID } }
    ])
    link.hostClosed('stop-all')

    expect(await running).toEqual({ kind: 'own-host', ensure: 'spawned' })
    expect(w.states).toEqual([
      { phase: 'incompatible', hostVersion: '0.22.0' },
      { phase: 'restarting', reason: 'stop-all' }
    ])
    expect(w.prepared).toBe(0)
  })

  it('[S12.21] an older UI whose stop-all could not end every session stays incompatible and starts nothing', async () => {
    const link = new FakeHostLink({
      protocolVersion: PROTOCOL_VERSION + 1,
      answers: {
        'host.shutdown': {
          ok: true,
          result: { mode: 'stop-all', outcome: { ended: [], failed: [FAILED_DWARF] } }
        }
      }
    })
    const w = world({ first: attached(link), confirm: true })

    const result = await runUpgradeFlow(w.deps)

    expect(result).toEqual({ kind: 'stop-all-incomplete', link, failed: [FAILED_DWARF] })
    expect(w.ensured).toBe(0)
    expect(w.states).toEqual([{ phase: 'incompatible', hostVersion: '0.20.0' }])
  })

  it('[ADR-002] a Host that closes without host.closing during the drain is a lost connection, never an upgrade: the flow starts no Host', async () => {
    const link = new FakeHostLink({ protocolVersion: PROTOCOL_VERSION - 1 })
    const w = world({ first: attached(link) })

    const running = runUpgradeFlow(w.deps)
    await settle()
    link.hostClosed(null)

    expect(await running).toEqual({ kind: 'lost' })
    expect(w.ensured).toBe(0)
    expect(w.states).toEqual([{ phase: 'compat', hostVersion: '0.20.0' }])
  })
})
