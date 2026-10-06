// layer: L2
import { afterEach, describe, expect, it } from 'vitest'
import {
  stopAllOutcomeSchema,
  type DwarfId,
  type DwarfWire,
  type HostParams,
  type HostResult,
  type MineId,
  type SnapshotChunk,
  type StopAllOutcome,
  type StranglerDwarfIdentity
} from '@dwarfai/contracts'
import { RecordingUiLog } from '../ui-main/hostLauncher/fakes/RecordingUiLog'
import { createHostClient, type HostClientService } from '../ui-main/host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from '../ui-main/host-client/testing/FakeHost'
import { FakeHostClientTimers } from '../ui-main/host-client/testing/FakeHostClientTimers'
import type { Dwarf, Mine, MineUndeclareResult, ProviderSnapshot } from '../main/domain/types'
import type { LaunchedProcess } from '../main/sessionLaunch/launchedSessions'
import type {
  LaunchedSessionStore,
  PersistedLaunch
} from '../main/sessionLaunch/launchedSessionStore'
import {
  createLegacyEndFirstAdapter,
  LEGACY_KILL_BOUND_MS,
  LegacyLaunchRegister,
  type LegacyEndFirstRemoval
} from './LegacyEndFirstAdapter'
import { createLegacyDwarfIdBridge, type LegacyDwarfIdBridge } from './LegacyDwarfIdBridge'
import { MINE_DWARF_NOT_ENDED } from './rowShapes/mineNotRemoved'

// L2 (17 §1): `LegacyEndFirstAdapter` (21 §3, cuts 0–4) on the A-N26 path of Stop everything and quit (ADR-002 D7;
// ADR-014 items 2, 9). The fake legacy runtime is today's launched register (`LegacyLaunchRegister` over the legacy
// `LaunchedSessionRegistry`) with scripted kills, whose verdict is the legacy runtime's own end report; the Host is a
// recording HostClient answering `host.shutdown`. TC-054-01, TC-054-02. A-N26 names Host dwarf ids only: a legacy end
// is never listed, and a legacy end that fails answers an INTERNAL error (owner ruling, 2026-10-01).

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
    timers: new FakeHostClientTimers()
  }
}

/** Lets the scripted kills and the promises behind them settle. */
async function settle(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/** Host dwarf ids (UUIDv7, `dwarfIdSchema`): the only ids a `StopAllOutcome` may carry. */
const H1 = '01890a5d-ac96-774b-bcce-b302099ad101'
const H2 = '01890a5d-ac96-774b-bcce-b302099ad102'
const H3 = '01890a5d-ac96-774b-bcce-b302099ad103'

/** The error branch A-N26 answers when a legacy-launched session could not be ended (owner ruling, 2026-10-01). */
const LEGACY_END_FAILED = { error: { code: 'INTERNAL', retryable: false } }

describe('LegacyEndFirstAdapter (21 §3) on A-N26', () => {
  it('[ADR-002] every legacy-launched session is ended and reported before host.shutdown stop-all is relayed', async () => {
    // TC-054-01
    const world = legacyWorld({ 101: 'held', 102: 'held' }, { ended: ids(H1), failed: [] })
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

    // The Host's outcome, unchanged: the legacy ends are never listed in it.
    expect(await answer).toEqual({ ended: [H1], failed: [] })
    expect(world.events).toEqual([
      'kill 101',
      'kill 102',
      'ended 102',
      'ended 101',
      'host.shutdown req-1'
    ])
    expect(world.host.calls).toEqual([['host.shutdown', { mode: 'stop-all', requestId: 'req-1' }]])
  })

  it('[ADR-002] a failed legacy kill answers an INTERNAL error and relays nothing', async () => {
    // TC-054-02
    const world = legacyWorld({ 101: 'refused', 102: 'ends' })
    world.launch(101)
    world.launch(102)
    world.register.observe([mine([dwarf('s-a'), dwarf('s-b')])])
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    await expect(adapter.beforeStopAll('req-2', world.shutdown)).rejects.toMatchObject(
      LEGACY_END_FAILED
    )

    expect(world.host.calls).toEqual([])
    // The refused session is still today's to end: a later Stop everything tries it again.
    expect(await world.register.liveLaunches()).toEqual([{ launchId: 'launch:1' }])
  })

  it('[ADR-002] a legacy end that throws answers an INTERNAL error and relays nothing', async () => {
    // TC-054-02
    const world = legacyWorld({})
    const adapter = createLegacyEndFirstAdapter({
      legacy: {
        liveLaunches: async () => [{ launchId: 'launch:1' }],
        endLaunch: () => Promise.reject(new Error('the legacy register could not be read'))
      },
      timers: world.timers
    })

    await expect(adapter.beforeStopAll('req-7', world.shutdown)).rejects.toMatchObject(
      LEGACY_END_FAILED
    )
    expect(world.host.calls).toEqual([])
    expect(world.timers.pending()).toBe(0)
  })

  it("[ADR-002] an end report that does not arrive within the legacy kill's bound counts as failed and relays nothing", async () => {
    // TC-054-02
    const world = legacyWorld({ 101: 'never', 102: 'ends' })
    world.launch(101)
    world.launch(102)
    world.register.observe([mine([dwarf('s-a'), dwarf('s-b')])])
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    let settled: { outcome?: StopAllOutcome; error?: unknown } | undefined
    void adapter.beforeStopAll('req-3', world.shutdown).then(
      (outcome) => (settled = { outcome }),
      (error: unknown) => (settled = { error })
    )
    await settle()
    world.timers.advance(LEGACY_KILL_BOUND_MS - 1)
    await settle()
    expect(settled).toBeUndefined()

    world.timers.advance(1)
    await settle()
    expect(settled).toMatchObject({ error: LEGACY_END_FAILED })
    expect(world.host.calls).toEqual([])
    expect(world.timers.pending()).toBe(0)
  })

  it('[ADR-014] with no legacy-launched session the adapter relays at once', async () => {
    const world = legacyWorld({}, { ended: ids(H1, H2), failed: ids(H3) })
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    const outcome = await adapter.beforeStopAll('req-4', world.shutdown)

    expect(outcome).toEqual({ ended: [H1, H2], failed: [H3] })
    expect(world.events).toEqual(['host.shutdown req-4'])
    expect(world.timers.pending()).toBe(0)
  })

  it("[ADR-014] sessions started in the person's own terminal are never ended by the adapter", async () => {
    // INV-120: only what DwarfAI started ends. The person's own session is on the board, observed, never retained; a
    // launch whose process already exited on its own is not signalled again.
    const world = legacyWorld({}, { ended: ids(H1), failed: [] })
    world.launch(101)
    world.launch(102).exit()
    world.register.observe([
      mine([dwarf('own', { id: 'claude:own', provider: 'claude' }), dwarf('s-a'), dwarf('s-b')])
    ])
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    const outcome = await adapter.beforeStopAll('req-5', world.shutdown)

    expect(outcome).toEqual({ ended: [H1], failed: [] })
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

    expect(outcome).toEqual({ ended: [], failed: [] })
    expect(world.events).toEqual(['kill 107', 'ended 107', 'host.shutdown req-6'])
  })

  it('[ADR-002] no legacy id ever appears in a successful outcome, which validates as a StopAllOutcome', async () => {
    // Owner ruling (2026-10-01): `ended` and `failed` carry Host DwarfIds only (dwarfIdSchema, ADR-015).
    const world = legacyWorld({}, { ended: ids(H1, H2), failed: ids(H3) })
    world.launch(101) // bound to a legacy dwarf below
    world.launch(102) // never shown on the legacy board: only its launch id names it
    world.register.observe([mine([dwarf('s-a')])])
    const adapter = createLegacyEndFirstAdapter({ legacy: world.register, timers: world.timers })

    const outcome = await adapter.beforeStopAll('req-8', world.shutdown)

    expect(world.events.filter((e) => e.startsWith('ended'))).toEqual(['ended 101', 'ended 102'])
    expect(stopAllOutcomeSchema.safeParse(outcome).success).toBe(true)
    expect([...outcome.ended, ...outcome.failed]).toEqual([H1, H2, H3])
  })
})

// L2 (17 §1): the A-32 half (21 §3 row `LegacyEndFirstAdapter`, from cut 1; 14 §2.1 A-32, §2.4 B-F10). The fake legacy
// runtime is the same scripted register; the Host is FakeHost behind the real HostClient, serving the board's `dwarfs`
// section, `dwarf.departed` frames and B-M41 for the bridge; the join is the real `LegacyDwarfIdBridge` over today's
// sessions. The Host sees a legacy launch as an observed dwarf with no process identity (15 §5), so the legacy kill ends
// it and the Host's `dwarf.departed` proves it gone before `mines.remove` is relayed. TC-090-01, TC-090-02.

const ALPHA = '01890a5d-ac96-774b-bcce-b302099ad201' as MineId
const BETA = '01890a5d-ac96-774b-bcce-b302099ad202' as MineId
const H4 = '01890a5d-ac96-774b-bcce-b302099ad104'

/** A present Host dwarf observed in `mineId` (14 §3.6 `DwarfWire`): observed, so not owned. */
function hostDwarf(id: string, mineId: MineId, providerId: string): DwarfWire {
  return {
    id: id as DwarfId,
    mineId,
    providerId,
    baseName: 'Thorin',
    customName: null,
    rank: 'worker',
    parentDwarfId: null,
    delegated: false,
    sessionProfile: { providerId },
    presence: 'present',
    processState: 'running',
    status: 'working',
    needsYou: false,
    canReceiveMessages: true,
    stopInFlight: false,
    stopUnavailableReason: null,
    owned: false,
    arrivedAt: 1_700_000_000_500
  }
}

const META: SnapshotChunk = {
  section: 'meta',
  data: {
    hostVersion: '0.0.0-fake',
    state: 'ready',
    resetEpoch: 0,
    snapshotTail: 20,
    minesEverKnown: true
  }
}

const REMOVAL_CAPABILITIES = [
  ...FAKE_HOST_CAPABILITIES,
  'section:dwarfs',
  'frame:dwarf.arrived',
  'frame:dwarf.departed',
  'strangler.dwarfIdentities'
]

/** One Host dwarf: where it is, and the provider session it is (the join's key, ADR-015 item 7). */
interface Present {
  dwarfId: string
  mineId: MineId
  providerId: 'codex' | 'claude'
  sessionId: string
}

const removalCleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of removalCleanups.splice(0)) cleanup()
})

/** The legacy world of `legacyWorld`, plus FakeHost, the HostClient, the bridge and the adapter's A-32 half. */
async function removalWorld(kills: Record<number, KillScript>, present: Present[]) {
  const world = legacyWorld(kills)
  let dwarfs = present.map((p) => hostDwarf(p.dwarfId, p.mineId, p.providerId))
  const host = new FakeHost({ capabilities: REMOVAL_CAPABILITIES })
  host.board = [META, { section: 'dwarfs', data: dwarfs }]
  host.handle('strangler.dwarfIdentities', (): StranglerDwarfIdentity[] =>
    present
      .filter((p) => dwarfs.some((d) => d.id === p.dwarfId))
      .map((p) => ({
        dwarfId: p.dwarfId as DwarfId,
        providerId: p.providerId,
        identity: { providerId: p.providerId, providerSessionId: p.sessionId }
      }))
  )
  const client: HostClientService = createHostClient({
    launcher: { ensureHostRunning: () => Promise.resolve('attached') },
    connect: host.connect,
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers: new FakeHostClientTimers(),
    log: new RecordingUiLog(),
    hungHost: { endHungHost: () => Promise.resolve({ outcome: 'identity-missing' }) }
  })
  // Today's sessions as `LegacyAgentRegistryFeed` wrote them: today's ids are `<provider>:<session>`.
  const legacyDwarfs = present.map((p) =>
    dwarf(p.sessionId, { id: `${p.providerId}:${p.sessionId}`, provider: p.providerId })
  )
  const sessions: ProviderSnapshot[] = legacyDwarfs.map((d) => ({
    provider: d.provider as ProviderSnapshot['provider'],
    sessionId: d.sessionId,
    cwd: MINE_PATH,
    status: 'busy',
    dwarfs: [d],
    updatedAt: 1
  }))
  const bridge: LegacyDwarfIdBridge = createLegacyDwarfIdBridge({
    client,
    legacy: { sessions: () => sessions }
  })
  const adapter: LegacyEndFirstRemoval = createLegacyEndFirstAdapter({
    legacy: world.register,
    timers: world.timers,
    host: { client, bridge }
  })
  removalCleanups.push(
    () => adapter.dispose(),
    () => bridge.dispose(),
    () => client.dispose()
  )
  await client.ensureHost()
  await settle(20)
  /** The relay ISSUE-091 hands the adapter: `mines.remove {mineId, requestId}`, recorded. */
  const removes: Array<[string, string]> = []
  const remove = async (mineId: string, requestId: string): Promise<MineUndeclareResult> => {
    removes.push([mineId, requestId])
    world.events.push(`mines.remove ${requestId}`)
    return { outcome: 'removed' }
  }
  return {
    ...world,
    adapter,
    remove,
    removes,
    /** Binds today's register to today's board, as the legacy runtime's own `observe` does. */
    observeLegacy: () => world.register.observe([mine(legacyDwarfs)]),
    /** The Host saw the dwarf go (B-F10): off the board, and the frame on the `ui` connection. */
    depart: (dwarfId: string) => {
      const gone = dwarfs.find((d) => d.id === dwarfId)
      dwarfs = dwarfs.filter((d) => d.id !== dwarfId)
      host.board = [META, { section: 'dwarfs', data: dwarfs }]
      world.events.push(`departed ${dwarfId}`)
      host.publish('dwarf.departed', {
        dwarfId,
        mineId: gone?.mineId ?? ALPHA,
        cause: 'closed-elsewhere'
      })
    }
  }
}

describe('A-32', () => {
  it('[ADR-014] every legacy-launched session of the mine is ended and its dwarf.departed received before mines.remove is relayed', async () => {
    // TC-090-01
    const world = await removalWorld({ 101: 'held', 102: 'held', 103: 'ends' }, [
      { dwarfId: H1, mineId: ALPHA, providerId: 'codex', sessionId: 's-a' },
      { dwarfId: H2, mineId: ALPHA, providerId: 'codex', sessionId: 's-b' },
      { dwarfId: H3, mineId: BETA, providerId: 'codex', sessionId: 's-c' }
    ])
    world.launch(101)
    world.launch(102)
    world.launch(103)
    world.observeLegacy()

    const answer = world.adapter.beforeRemoveMine(ALPHA, 'req-1', world.remove)
    await settle(20)
    // Only the mine's own launches are ended, in parallel; the other mine's launch is untouched.
    expect(world.events).toEqual(['kill 101', 'kill 102'])

    world.release(101)
    world.release(102)
    await settle(20)
    // Both kills reported success, but the Host has not seen either dwarf go: nothing is relayed yet.
    expect(world.removes).toEqual([])

    world.depart(H1)
    await settle(20)
    expect(world.removes).toEqual([])

    world.depart(H2)
    expect(await answer).toEqual({ outcome: 'removed' })
    expect(world.events).toEqual([
      'kill 101',
      'kill 102',
      'ended 101',
      'ended 102',
      `departed ${H1}`,
      `departed ${H2}`,
      'mines.remove req-1'
    ])
    expect(world.removes).toEqual([[ALPHA, 'req-1']])
    expect(world.timers.pending()).toBe(0)
  })

  it('[ADR-014] a failed legacy kill answers unchanged with dwarf-could-not-be-ended and relays nothing', async () => {
    // TC-090-02
    const world = await removalWorld({ 101: 'refused', 102: 'ends' }, [
      { dwarfId: H1, mineId: ALPHA, providerId: 'codex', sessionId: 's-a' },
      { dwarfId: H2, mineId: ALPHA, providerId: 'codex', sessionId: 's-b' }
    ])
    world.launch(101)
    world.launch(102)
    world.observeLegacy()

    const answer = world.adapter.beforeRemoveMine(ALPHA, 'req-2', world.remove)
    await settle(20)
    world.depart(H2)

    expect(await answer).toEqual({ outcome: 'unchanged', reason: 'dwarf-could-not-be-ended' })
    expect(MINE_DWARF_NOT_ENDED).toEqual({
      outcome: 'unchanged',
      reason: 'dwarf-could-not-be-ended'
    })
    expect(world.removes).toEqual([])
    expect(world.timers.pending()).toBe(0)
  })

  it('[ADR-014] a departure that does not arrive within the legacy bound counts as failed', async () => {
    // TC-090-02
    const world = await removalWorld({ 101: 'ends' }, [
      { dwarfId: H1, mineId: ALPHA, providerId: 'codex', sessionId: 's-a' }
    ])
    world.launch(101)
    world.observeLegacy()

    let settled: MineUndeclareResult | undefined
    void world.adapter.beforeRemoveMine(ALPHA, 'req-3', world.remove).then((r) => (settled = r))
    await settle(20)
    expect(world.events.slice(0, 2)).toEqual(['kill 101', 'ended 101'])
    world.timers.advance(LEGACY_KILL_BOUND_MS - 1)
    await settle(20)
    expect(settled).toBeUndefined()

    world.timers.advance(1)
    await settle(20)
    expect(settled).toEqual(MINE_DWARF_NOT_ENDED)
    expect(world.removes).toEqual([])
    expect(world.timers.pending()).toBe(0)
  })

  it('[ADR-014] a mine with no legacy-launched session relays mines.remove at once', async () => {
    // A session the person started in their own terminal (INV-120) and a Host dwarf of another mine are never ended
    // here: the Host ends what it can itself (B-M18).
    const world = await removalWorld({ 101: 'ends' }, [
      { dwarfId: H4, mineId: ALPHA, providerId: 'claude', sessionId: 'own' },
      { dwarfId: H1, mineId: BETA, providerId: 'codex', sessionId: 's-a' }
    ])
    world.launch(101)
    world.observeLegacy()

    expect(await world.adapter.beforeRemoveMine(ALPHA, 'req-4', world.remove)).toEqual({
      outcome: 'removed'
    })
    expect(world.events).toEqual(['mines.remove req-4'])
    expect(world.timers.pending()).toBe(0)
  })
})
