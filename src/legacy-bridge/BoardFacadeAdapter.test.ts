// layer: L2
import { afterEach, describe, expect, it } from 'vitest'
import type {
  DwarfId,
  DwarfWire,
  FolderPath,
  MineId,
  MineWire,
  SnapshotChunk
} from '@dwarfai/contracts'
import type { MaterialTotals, MinesSnapshot } from '../shared/contracts'
import { RecordingUiLog } from '../ui-main/hostLauncher/fakes/RecordingUiLog'
import { createHostClient, type HostClientService } from '../ui-main/host-client/HostClient'
import { FAKE_HOST_CAPABILITIES, FakeHost } from '../ui-main/host-client/testing/FakeHost'
import { FakeHostClientTimers } from '../ui-main/host-client/testing/FakeHostClientTimers'
import type { HostClient } from '../ui-main/window/ports/hostClient'
import { createBoardFacadeAdapter, type BoardFacade } from './BoardFacadeAdapter'

// L2 (17 §1): `BoardFacadeAdapter` (21 §3, cuts 1–4; 14 §5) over the real HostClient and FakeHost, the in-process
// fake Host speaking seam B (ADR-003 items 7–8; 14 §4.2, §4.3). The fixture world is one Host board and the board
// today's runtime publishes for the same mines and sessions, written by hand from today's `MinesSnapshot`; the facade's
// board must equal it on mines, present dwarfs and material totals (21 §2 cut 1 "Board parity"). Ids are not facts:
// from cut 1 the renderer knows Host ids only (14 §5 `LegacyDwarfIdBridge`). The macrotask boundary of A-P2 is the
// test's (`defer`), so no real timer runs. TC-086-01, TC-086-02.

const ALPHA = '01920000-0000-7000-9000-0000000b0001' as MineId
const BETA = '01920000-0000-7000-9000-0000000b0002' as MineId
const dwarfId = (n: number) =>
  `01920000-0000-7000-9000-0000000e00${String(n).padStart(2, '0')}` as DwarfId
const THORIN = dwarfId(1)
const KILI = dwarfId(2)
const BALIN = dwarfId(3)
const ORI = dwarfId(4)
const GIMLI = dwarfId(5)

const tokens = (n: number) => ({ tokens: n })
const noOre = {
  coal: tokens(0),
  bronze: tokens(0),
  copper: tokens(0),
  silver: tokens(0),
  gold: tokens(0),
  uranium: tokens(0)
}

const alpha: MineWire = {
  id: ALPHA,
  path: '/work/alpha' as FolderPath,
  name: 'alpha',
  state: 'active',
  tier: 'gold',
  hasBeenMeasured: true,
  lastUsedAt: 1_700_000_000_000,
  totals: { ...noOre, coal: tokens(120), copper: tokens(3_400), gold: tokens(90_000) }
}
const beta: MineWire = {
  id: BETA,
  path: '/work/beta' as FolderPath,
  name: 'beta',
  state: 'active',
  tier: 'copper',
  hasBeenMeasured: true,
  lastUsedAt: 1_700_000_000_000,
  totals: { ...noOre, copper: tokens(700) }
}

function dwarf(
  over: Partial<DwarfWire> & Pick<DwarfWire, 'id' | 'mineId' | 'baseName'>
): DwarfWire {
  return {
    providerId: 'claude',
    customName: null,
    rank: 'worker',
    parentDwarfId: null,
    delegated: false,
    sessionProfile: { providerId: over.providerId ?? 'claude' },
    presence: 'present',
    processState: 'running',
    status: 'working',
    needsYou: false,
    canReceiveMessages: true,
    stopInFlight: false,
    stopUnavailableReason: null,
    owned: false,
    arrivedAt: 1_700_000_000_500,
    ...over
  }
}

const thorin = dwarf({
  id: THORIN,
  mineId: ALPHA,
  baseName: 'Thorin',
  customName: 'Lead',
  rank: 'foreman'
})
const kili = dwarf({
  id: KILI,
  mineId: ALPHA,
  baseName: 'Kili',
  providerId: 'codex',
  status: 'asking',
  needsYou: true
})
const balin = dwarf({
  id: BALIN,
  mineId: ALPHA,
  baseName: 'Balin',
  presence: 'walking-out',
  status: 'idle'
})
const ori = dwarf({
  id: ORI,
  mineId: BETA,
  baseName: 'Ori',
  providerId: 'opencode',
  presence: 'resuming',
  status: 'asleep'
})
const gimli = dwarf({
  id: GIMLI,
  mineId: BETA,
  baseName: 'Gimli',
  providerId: 'codex',
  rank: 'worker2'
})

const meta: SnapshotChunk = {
  section: 'meta',
  data: {
    hostVersion: '0.0.0-fake',
    state: 'ready',
    resetEpoch: 0,
    snapshotTail: 20,
    minesEverKnown: true
  }
}
const board = (mines: MineWire[], dwarfs: DwarfWire[]): SnapshotChunk[] => [
  meta,
  { section: 'mines', data: mines },
  { section: 'dwarfs', data: dwarfs }
]

const CAPABILITIES = [
  ...FAKE_HOST_CAPABILITIES,
  'section:mines',
  'section:dwarfs',
  'frame:mine.changed',
  'frame:dwarf.arrived',
  'frame:dwarf.changed',
  'frame:dwarf.departed'
]

const clients: HostClientService[] = []
const facades: BoardFacade[] = []
afterEach(() => {
  for (const facade of facades.splice(0)) facade.dispose()
  for (const client of clients.splice(0)) client.dispose()
})

/** Lets the in-memory pipes and the promises behind them settle. */
async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve))
}

/** The HostClient port, every member call recorded by name (TC-086-02). */
function recording(client: HostClient, calls: string[]): HostClient {
  return new Proxy(client, {
    get(target, member, receiver) {
      const value: unknown = Reflect.get(target, member, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(String(member))
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
  })
}

function world(chunks: SnapshotChunk[]) {
  const host = new FakeHost({ capabilities: CAPABILITIES })
  host.board = chunks
  host.pageSize = 2
  const timers = new FakeHostClientTimers()
  const client = createHostClient({
    launcher: { ensureHostRunning: () => Promise.resolve('attached') },
    connect: host.connect,
    readToken: () => Promise.resolve(host.token),
    protocolVersion: 1,
    client: { appVersion: '0.0.0-test', buildId: 'test', pid: 4242 },
    timers,
    log: new RecordingUiLog(),
    hungHost: { endHungHost: () => Promise.resolve({ outcome: 'identity-missing' }) }
  })
  clients.push(client)
  const calls: string[] = []
  const pushes: MinesSnapshot[] = []
  const macrotasks: Array<() => void> = []
  const facade = createBoardFacadeAdapter({
    client: recording(client, calls),
    push: (snapshot) => pushes.push(snapshot),
    defer: (run) => macrotasks.push(run)
  })
  facades.push(facade)
  /** Lets the pipes settle, then runs the macrotasks the facade queued. */
  const flush = async (): Promise<void> => {
    await settle()
    for (const run of macrotasks.splice(0)) run()
  }
  return { host, timers, client, calls, pushes, facade, flush }
}

/** The facts the board shows (21 §2 cut 1 "Board parity"): mines, their present dwarfs, and the material totals. */
function facts(snapshot: MinesSnapshot) {
  return {
    mines: snapshot.mines
      .map((mine) => ({
        path: mine.path,
        name: mine.name,
        tier: mine.tier,
        materials: mine.materials,
        dwarfs: mine.dwarfs
          .map((d) => ({
            provider: d.provider,
            role: d.role,
            name: d.name,
            customName: d.customName,
            status: d.status
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    materials: snapshot.materials
  }
}

const vault = (...parts: Partial<MaterialTotals>[]): MaterialTotals => {
  const sum: MaterialTotals = { coal: 0, bronze: 0, copper: 0, silver: 0, gold: 0, uranium: 0 }
  for (const part of parts)
    for (const [material, n] of Object.entries(part)) sum[material as keyof MaterialTotals] += n
  return sum
}

/**
 * Today's board for the fixture world after its frames, as today's runtime publishes it (`MinesSnapshot` of
 * src/shared/contracts.ts): legacy ids, the provider's session ids, the leaving dwarf still on the board.
 */
const ALPHA_ORE = vault({ coal: 120, copper: 3_400, gold: 91_000 })
const BETA_ORE = vault({ copper: 700 })
const LEGACY_BOARD: MinesSnapshot = {
  mines: [
    {
      id: 'mine-7f3a',
      path: '/work/alpha',
      name: 'alpha',
      tier: 'gold',
      dwarfs: [
        {
          id: 'legacy-1',
          provider: 'claude',
          role: 'foreman',
          name: 'Thorin',
          customName: 'Lead',
          status: 'working',
          sessionId: 's-1'
        },
        {
          id: 'legacy-2',
          provider: 'codex',
          role: 'worker',
          name: 'Kili',
          status: 'waiting',
          sessionId: 's-2'
        },
        {
          id: 'legacy-3',
          provider: 'claude',
          role: 'worker',
          name: 'Balin',
          status: 'leaving',
          sessionId: 's-3'
        }
      ],
      tokensObserved: 0,
      materials: ALPHA_ORE,
      updatedAt: 1_700_000_000_000
    },
    {
      id: 'mine-91c0',
      path: '/work/beta',
      name: 'beta',
      tier: 'copper',
      dwarfs: [
        {
          id: 'legacy-4',
          provider: 'opencode',
          role: 'worker',
          name: 'Ori',
          status: 'waiting',
          sessionId: 's-4'
        },
        {
          id: 'legacy-5',
          provider: 'codex',
          role: 'worker2',
          name: 'Gimli',
          status: 'working',
          sessionId: 's-5'
        }
      ],
      tokensObserved: 0,
      materials: BETA_ORE,
      updatedAt: 1_700_000_000_000
    }
  ],
  tokensObserved: 0,
  materials: vault(ALPHA_ORE, BETA_ORE)
}

describe('BoardFacadeAdapter over HostClient and FakeHost (21 §3; 14 §5)', () => {
  it('[ADR-001] for the fixture world the facade’s board equals the legacy board on mines, present dwarfs and material totals', async () => {
    const { host, client, pushes, facade, flush } = world(
      board([alpha, beta], [thorin, kili, balin, ori])
    )
    await client.ensureHost()
    await flush()
    // After the snapshot, a dwarf arrives and the ledger credits alpha (its totals travel with the mine).
    host.publish('dwarf.arrived', { dwarf: gimli, announce: true })
    host.publish('mine.changed', {
      mine: { ...alpha, totals: { ...alpha.totals, gold: tokens(91_000) } }
    })
    await flush()

    expect(facts(facade.getMines())).toEqual(facts(LEGACY_BOARD))
    // A-P2 pushed the same board, once per macrotask that changed it.
    expect(pushes).toHaveLength(2)
    expect(facts(pushes.at(-1) as MinesSnapshot)).toEqual(facts(LEGACY_BOARD))
    // The renderer knows Host ids from cut 1 on.
    expect(
      facade
        .getMines()
        .mines.map((m) => m.id)
        .sort()
    ).toEqual([ALPHA, BETA])
  })

  it('[ADR-001] a dwarf.departed frame removes the dwarf from the next onMinesUpdated push', async () => {
    const { host, client, pushes, facade, flush } = world(board([alpha], [thorin, kili]))
    await client.ensureHost()
    await flush()
    expect(pushes.at(-1)?.mines[0]?.dwarfs.map((d) => d.id)).toEqual([THORIN, KILI])

    host.publish('dwarf.departed', { dwarfId: KILI, mineId: ALPHA, cause: 'closed-elsewhere' })
    await flush()

    expect(pushes.at(-1)?.mines[0]?.dwarfs.map((d) => d.id)).toEqual([THORIN])
    expect(facade.getMines()).toEqual(pushes.at(-1))
  })

  it('[ADR-003] resync-required makes the facade re-snapshot and frames with seq at or below the snapshot are dropped', async () => {
    const { host, timers, client, facade, flush } = world(board([alpha], [thorin]))
    await client.ensureHost()
    await flush()
    host.publish('dwarf.arrived', { dwarf: kili, announce: false })
    await flush()
    expect(facade.getMines().mines[0]?.dwarfs.map((d) => d.id)).toEqual([THORIN, KILI])

    // The connection drops; while it is down the Host's board moves on (Thorin and Kili leave, Ori arrives) and its
    // ring forgets those frames, so the resume is answered `resync-required {seq-not-in-ring}` (14 §4.3 rule 2).
    host.dropConnections('ui')
    await settle()
    const oriHere = { ...ori, mineId: ALPHA }
    host.publish('dwarf.departed', { dwarfId: THORIN, mineId: ALPHA, cause: 'stopped' })
    host.publish('dwarf.departed', { dwarfId: KILI, mineId: ALPHA, cause: 'stopped' })
    host.forgetThrough(host.publish('dwarf.arrived', { dwarf: oriHere, announce: true }))
    host.board = board([alpha], [oriHere])
    // Right after the subscribe answer, before the new snapshot is built, a frame that snapshot already reflects
    // (seq ≤ S): Kili's arrival again. While the snapshot is read, a newer frame (seq > S) renames Ori.
    let stale = -1
    let snapshotSeq = -1
    let late = -1
    host.afterSubscribe = () => {
      stale = host.publish('dwarf.arrived', { dwarf: kili, announce: false })
    }
    host.beforePage = (index) => {
      if (index !== 0) return
      snapshotSeq = host.currentSeq()
      late = host.publish('dwarf.changed', { dwarf: { ...oriHere, customName: 'Scribe' } })
    }
    timers.advance(250)
    await flush()

    expect(
      host.received.filter((r) => r.method === 'events.subscribe').at(-1)?.params
    ).toMatchObject({
      resume: { epoch: 'epoch-1' }
    })
    expect(stale).toBeGreaterThan(0)
    expect(stale).toBeLessThanOrEqual(snapshotSeq)
    expect(late).toBeGreaterThan(snapshotSeq)
    // The new snapshot replaced the board; the stale frame was dropped; the newer one applied.
    expect(
      facade.getMines().mines[0]?.dwarfs.map((d) => ({ id: d.id, customName: d.customName }))
    ).toEqual([{ id: ORI, customName: 'Scribe' }])
  })

  it('[ADR-001] the facade never calls a mutating Host method', async () => {
    const { host, client, calls, facade, flush } = world(board([alpha, beta], [thorin, kili, ori]))
    await client.ensureHost()
    await flush()
    host.publish('dwarf.arrived', { dwarf: gimli, announce: true })
    host.publish('dwarf.departed', { dwarfId: KILI, mineId: ALPHA, cause: 'stopped' })
    host.publish('resync-required', { reason: 'backpressure' })
    await flush()
    facade.getMines()
    facade.refresh()
    await flush()
    facade.dispose()

    // TC-086-02: of the HostClient port the facade only subscribes (and its answer, the unsubscribe, ends it) …
    expect(calls).toEqual(['subscribe'])
    // … and on the wire nothing but the handshake, the subscribe and the snapshot pages reached the Host.
    expect([...new Set(host.hellos.map(() => 'hello'))]).toEqual(['hello'])
    expect([...new Set(host.methods())].sort()).toEqual(['events.subscribe', 'session.snapshot'])
  })
})
