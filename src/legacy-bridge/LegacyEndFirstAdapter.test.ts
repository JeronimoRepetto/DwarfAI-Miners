// layer: L2
import { describe, expect, it } from 'vitest'
import type { DwarfId, HostParams, HostResult, StopAllOutcome } from '@dwarfai/contracts'
import { ManualTimers } from '../ui-main/host-client/testing/ManualTimers'
import type { Dwarf, Mine } from '../main/domain/types'
import type { LaunchedProcess } from '../main/sessionLaunch/launchedSessions'
import type {
  LaunchedSessionStore,
  PersistedLaunch
} from '../main/sessionLaunch/launchedSessionStore'
import {
  createLegacyEndFirstAdapter,
  LEGACY_KILL_BOUND_MS,
  LegacyLaunchRegister
} from './LegacyEndFirstAdapter'

// L2 (17 §1): `LegacyEndFirstAdapter` (21 §3, cuts 0–4) on the A-N26 path of Stop everything and quit (ADR-002 D7;
// ADR-014 items 2, 9). The fake legacy runtime is today's launched register (`LegacyLaunchRegister` over the legacy
// `LaunchedSessionRegistry`) with scripted kills, whose verdict is the legacy runtime's own end report; the Host is a
// recording HostClient answering `host.shutdown`. TC-054-01, TC-054-02.

const MINE_PATH = '/work/project'

/** The Host's dwarf ids in a scripted outcome. */
const ids = (...names: string[]): DwarfId[] => names as DwarfId[]

function dwarf(sessionId: string, overrides: Partial<Dwarf> = {}): Dwarf {
  return {
    id: `codex:${sessionId}`,
    provider: 'codex',
    role: 'worker',
    name: `codex-${sessionId}`,
    status: 'working',
    sessionId,
    ...overrides
  }
}

function mine(dwarfs: Dwarf[]): Mine {
  return {
    id: `mine:${MINE_PATH}`,
    path: MINE_PATH,
    name: 'project',
    tier: 'bronze',
    dwarfs,
    tokensObserved: 0,
    updatedAt: 1
  }
}

/** How the scripted kill of one pid answers: at once, refused, held until released, or never. */
type KillScript = 'ends' | 'refused' | 'held' | 'never'

/** Today's launched register with scripted identity-checked kills, and the Host behind a recording HostClient. */
function legacyWorld(
  kills: Record<number, KillScript>,
  hostOutcome: StopAllOutcome = { ended: [], failed: [] },
  options: {
    store?: LaunchedSessionStore
    processStartTimeMs?: (pid: number) => Promise<number | null>
  } = {}
) {
  /** Every kill, end report and relay, in the order they happened. */
  const events: string[] = []
  const held = new Map<number, (ended: boolean) => void>()
  const register = new LegacyLaunchRegister({
    endProcessTree: (pid) => {
      events.push(`kill ${pid}`)
      const script = kills[pid] ?? 'ends'
      const report = (ended: boolean): boolean => {
        events.push(`${ended ? 'ended' : 'refused'} ${pid}`)
        return ended
      }
      if (script === 'ends') return Promise.resolve(report(true))
      if (script === 'refused') return Promise.resolve(report(false))
      if (script === 'never') return new Promise<boolean>(() => {})
      return new Promise<boolean>((resolve) => held.set(pid, (ended) => resolve(report(ended))))
    },
    ...options
  })
  /** The recording HostClient: every call it was asked to send. */
  const host = {
    calls: [] as Array<[string, unknown]>,
    async call(
      method: 'host.shutdown',
      params: HostParams['host.shutdown']
    ): Promise<HostResult['host.shutdown']> {
      host.calls.push([method, params])
      events.push(`${method} ${'requestId' in params ? params.requestId : ''}`)
      return { mode: 'stop-all', outcome: hostOutcome }
    }
  }
  /** The relay stopEverything hands the adapter: `host.shutdown {mode:'stop-all'}` on the ui connection. */
  const shutdown = async (requestId: string): Promise<StopAllOutcome> => {
    const result = await host.call('host.shutdown', { mode: 'stop-all', requestId })
    if (result.mode !== 'stop-all') throw new Error('not a stop-all answer')
    return result.outcome
  }
  /** Retains a detached launch of today's runtime, as `launchAgent` does; `exit` is its own end. */
  function launch(pid: number): { exit(): void } {
    const exits: Array<() => void> = []
    const process: LaunchedProcess = { pid, onExit: (listener) => void exits.push(listener) }
    register.retain({ provider: 'codex', minePath: MINE_PATH, process, knownSessionIds: [] })
    return { exit: () => exits.forEach((exit) => exit()) }
  }
  return {
    register,
    events,
    host,
    shutdown,
    launch,
    release: (pid: number, ended = true) => held.get(pid)?.(ended),
    timers: new ManualTimers()
  }
}

/** Lets the scripted kills and the promises behind them settle. */
async function settle(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

describe('LegacyEndFirstAdapter (21 §3) on A-N26', () => {
  it('[ADR-002] every legacy-launched session is ended and reported before host.shutdown stop-all is relayed', async () => {
    // TC-054-01
    const world = legacyWorld({ 101: 'held', 102: 'held' }, { ended: ids('h-1'), failed: [] })
    world.launch(101)
    world.launch(102)
    world.register.observe([mine([dwarf('s-a'), dwarf('s-b')])])
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    const answer = adapter.beforeStopAll('req-1', world.shutdown)
    await settle()
    // Both kills went out in parallel; nothing is relayed while an end report is still outstanding.
    expect(world.events).toEqual(['kill 101', 'kill 102'])

    world.release(102)
    await settle()
    expect(world.host.calls).toEqual([])
    world.release(101)

    expect(await answer).toEqual({ ended: ['codex:s-a', 'codex:s-b', 'h-1'], failed: [] })
    expect(world.events).toEqual([
      'kill 101',
      'kill 102',
      'ended 102',
      'ended 101',
      'host.shutdown req-1'
    ])
    expect(world.host.calls).toEqual([['host.shutdown', { mode: 'stop-all', requestId: 'req-1' }]])
  })

  it('[ADR-002] a failed legacy kill answers a StopAllOutcome naming that dwarf and relays nothing', async () => {
    // TC-054-02
    const world = legacyWorld({ 101: 'refused', 102: 'ends' })
    world.launch(101)
    world.launch(102)
    world.register.observe([mine([dwarf('s-a'), dwarf('s-b')])])
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    const outcome = await adapter.beforeStopAll('req-2', world.shutdown)

    expect(outcome).toEqual({ ended: ['codex:s-b'], failed: ['codex:s-a'] })
    expect(world.host.calls).toEqual([])
    // The refused session is still today's to end: a later Stop everything tries it again.
    expect(await world.register.liveLaunches()).toEqual([
      { launchId: 'launch:1', dwarfId: 'codex:s-a' }
    ])
  })

  it("[ADR-002] an end report that does not arrive within the legacy kill's bound counts as failed and relays nothing", async () => {
    // TC-054-02
    const world = legacyWorld({ 101: 'never', 102: 'ends' })
    world.launch(101)
    world.launch(102)
    world.register.observe([mine([dwarf('s-a'), dwarf('s-b')])])
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    let outcome: StopAllOutcome | undefined
    void adapter.beforeStopAll('req-3', world.shutdown).then((answer) => (outcome = answer))
    await settle()
    world.timers.advance(LEGACY_KILL_BOUND_MS - 1)
    await settle()
    expect(outcome).toBeUndefined()

    world.timers.advance(1)
    await settle()
    expect(outcome).toEqual({ ended: ['codex:s-b'], failed: ['codex:s-a'] })
    expect(world.host.calls).toEqual([])
    expect(world.timers.pending()).toBe(0)
  })

  it('[ADR-014] with no legacy-launched session the adapter relays at once', async () => {
    const world = legacyWorld({}, { ended: ids('h-1', 'h-2'), failed: ids('h-3') })
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    const outcome = await adapter.beforeStopAll('req-4', world.shutdown)

    expect(outcome).toEqual({ ended: ['h-1', 'h-2'], failed: ['h-3'] })
    expect(world.events).toEqual(['host.shutdown req-4'])
    expect(world.timers.pending()).toBe(0)
  })

  it("[ADR-014] sessions started in the person's own terminal are never ended by the adapter", async () => {
    // INV-120: only what DwarfAI started ends. The person's own session is on the board, observed, never retained; a
    // launch whose process already exited on its own is not signalled again.
    const world = legacyWorld({}, { ended: [], failed: [] })
    world.launch(101)
    world.launch(102).exit()
    world.register.observe([
      mine([dwarf('own', { id: 'claude:own', provider: 'claude' }), dwarf('s-a'), dwarf('s-b')])
    ])
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    const outcome = await adapter.beforeStopAll('req-5', world.shutdown)

    expect(outcome).toEqual({ ended: ['codex:s-a'], failed: [] })
    expect(world.events).toEqual(['kill 101', 'ended 101', 'host.shutdown req-5'])
  })

  it('[ADR-014] a session a previous run launched, restored from launched_sessions, is ended first too', async () => {
    // 21 §5.3: the legacy register reads `launched_sessions`; the adapter reaches it only through that register.
    const row: PersistedLaunch = {
      launchId: 'launch:7',
      provider: 'codex',
      sessionId: 's-old',
      minePath: MINE_PATH,
      pid: 107,
      processStartTimeMs: 1_000,
      routedByJev: false
    }
    const rows = new Map([[row.launchId, row]])
    const store: LaunchedSessionStore = {
      list: async () => [...rows.values()],
      put: async (launch) => void rows.set(launch.launchId, launch),
      remove: async (launchId) => void rows.delete(launchId)
    }
    const world = legacyWorld(
      {},
      { ended: [], failed: [] },
      { store, processStartTimeMs: async () => 1_000 }
    )
    await world.register.restore()
    world.register.observe([mine([dwarf('s-old')])])
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    const outcome = await adapter.beforeStopAll('req-6', world.shutdown)

    expect(outcome).toEqual({ ended: ['codex:s-old'], failed: [] })
    expect(world.events).toEqual(['kill 107', 'ended 107', 'host.shutdown req-6'])
  })
})
