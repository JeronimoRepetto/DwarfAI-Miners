// layer: L2
// L2 (17 §1.2): Remove mine (16 §4.1 `MinesCommands.remove`; UC-020; 07 S3.15–S3.17; 06 INV-06,
// INV-96; ADR-014 item 6) over the repository double, a recording bus and crew's `endAllIn` as mines
// sees it along its one edge (05 §1.3): a double that ends the scripted dwarfs, departing each ended
// one `mine-removed` before it answers, as crew's contract says (16 §4.2). Crew's own side of it is
// proven in crew's `endAllIn.test.ts`, and the two together in `wiring/flows/removeMine.flow.test.ts`.
//
// TC-080-01, TC-080-02.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { CrewEnds } from '../../crew'
import { mapMarkerOf, mineIdOf, mineNameOf, openMine, type Mine } from '../domain/mine'
import type { MinePath } from '../domain/minePath'
import { InMemoryMineRepository } from '../testing/InMemoryMineRepository'
import type { MinesEvent } from './events'
import { MineReadModel } from './mineQueries'
import { createRemove } from './remove'

const T0 = 1_790_000_000_000
const T_REMOVE = T0 + 60_000
const REQUEST = 'remove-request-1'
const MINE = mineIdOf('01890a5d-ac96-774b-bcce-0000000000a1')
const OTHER = mineIdOf('01890a5d-ac96-774b-bcce-0000000000a2')
const BORIN = '01890a5d-ac96-774b-bcce-0000000000d1' as DwarfId
const DAIN = '01890a5d-ac96-774b-bcce-0000000000d2' as DwarfId

/** crew's `endAllIn` as mines calls it: every seated dwarf ends unless scripted to fail. */
class CrewEndsDouble implements CrewEnds {
  readonly calls: Array<{ mineId: MineId; requestId: string }> = []
  readonly seated = new Map<MineId, DwarfId[]>()
  readonly failing = new Set<DwarfId>()

  constructor(private readonly timeline: string[]) {}

  endAllIn(mineId: MineId, requestId: string): Promise<{ ended: DwarfId[]; failed: DwarfId[] }> {
    this.calls.push({ mineId, requestId })
    this.timeline.push(`endAllIn ${mineId}`)
    const crew = this.seated.get(mineId) ?? []
    const ended = crew.filter((dwarfId) => !this.failing.has(dwarfId))
    const failed = crew.filter((dwarfId) => this.failing.has(dwarfId))
    // Crew departs each ended dwarf `mine-removed` before it answers (16 §4.2; S2.05).
    for (const dwarfId of ended) this.timeline.push(`DwarfDeparted ${dwarfId} mine-removed`)
    this.seated.set(mineId, failed)
    return Promise.resolve({ ended, failed })
  }
}

function world() {
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  let open = false
  const scope = { isInTransaction: () => open }
  const repository = new InMemoryMineRepository({
    scope,
    mapSites: [{ xPct: 10, yPct: 20 }],
    random: () => 0
  })
  const transactions = {
    inTransaction<T>(work: () => T): T {
      if (open) return work()
      open = true
      const before = repository.snapshot()
      try {
        return work()
      } catch (error) {
        repository.restore(before)
        throw error
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<MinesEvent>({ transactionScope: scope })
  const timeline: string[] = []
  bus.subscribe('MineRemoved', (event) => timeline.push(event.type))
  bus.subscribe('MineRemovalFailed', (event) => timeline.push(event.type))
  const crew = new CrewEndsDouble(timeline)
  const remeasured: MineId[] = []
  const { remove } = createRemove({
    repository,
    transactions,
    bus,
    clock,
    ids,
    hostEpoch: 'epoch-080',
    crew,
    abortWalk: (mineId) => timeline.push(`abortWalk ${mineId}`),
    remeasure: (mineId) => remeasured.push(mineId)
  })
  const queries = new MineReadModel({ repository, presentDwarfs: repository })
  /** A mine stored with `over`, with `dwarfs` seated in it, as the repository returns it. */
  const mine = (id: MineId, name: string, over: Partial<Mine>, dwarfs: DwarfId[] = []): Mine => {
    const opened = openMine(
      {
        cause: 'declared',
        birth: { id, path: `/work/${name}` as MinePath, name: mineNameOf(name) }
      },
      T0
    ).mine as Mine
    const stored: Mine = { ...opened, ...over }
    transactions.inTransaction(() => repository.save(stored))
    crew.seated.set(id, dwarfs)
    dwarfs.forEach(() => repository.seatDwarf(id, true))
    // As stored: the first save picked its map site.
    return repository.byId(id) as Mine
  }
  clock.advance(T_REMOVE - T0)
  return { repository, bus, crew, timeline, remove, queries, mine, remeasured }
}

const ACTIVE: Partial<Mine> = {
  state: 'active',
  tier: 'gold',
  sourceWeight: { bytes: 4_000_000 },
  hasBeenMeasured: true,
  measuredAt: T0
}

describe('MinesCommands.remove (16 §4.1, UC-020)', () => {
  it('[US-MINES-006.AC03, S3.16, BR-04] when every dwarf ended the mine is removed, each dwarf departs mine-removed and MineRemoved follows', async () => {
    const w = world()
    w.mine(MINE, 'alpha', ACTIVE, [BORIN, DAIN])

    expect(await w.remove(MINE, REQUEST)).toEqual({ ok: true, value: undefined })

    expect(w.crew.calls).toEqual([{ mineId: MINE, requestId: REQUEST }])
    expect(w.timeline).toEqual([
      `abortWalk ${MINE}`,
      `endAllIn ${MINE}`,
      `DwarfDeparted ${BORIN} mine-removed`,
      `DwarfDeparted ${DAIN} mine-removed`,
      'MineRemoved'
    ])
    expect(w.repository.byId(MINE)).toMatchObject({ state: 'removed', removedAt: T_REMOVE })
    expect(w.bus.ofType('MineRemoved')).toEqual([
      expect.objectContaining({
        v: 1,
        at: T_REMOVE,
        hostEpoch: 'epoch-080',
        payload: { mineId: MINE, removedAt: T_REMOVE }
      })
    ])
    expect(w.bus.ofType('MineRemovalFailed')).toEqual([])
  })

  it('[US-OBS-005.AC05, S2.05] every dwarf of the removed mine departs with cause mine-removed, so its panel closes', async () => {
    const w = world()
    w.mine(MINE, 'alpha', ACTIVE, [BORIN, DAIN])
    w.mine(OTHER, 'beta', ACTIVE, ['01890a5d-ac96-774b-bcce-0000000000d9' as DwarfId])

    await w.remove(MINE, REQUEST)

    // Crew is asked for this mine's dwarfs only, and every one of them departed before the mine
    // left the board: their open panels close with the mine (PO #49), none goes read-only.
    expect(w.crew.calls.map((call) => call.mineId)).toEqual([MINE])
    const departures = w.timeline.filter((line) => line.startsWith('DwarfDeparted'))
    expect(departures).toEqual([
      `DwarfDeparted ${BORIN} mine-removed`,
      `DwarfDeparted ${DAIN} mine-removed`
    ])
    expect(w.timeline.indexOf('MineRemoved')).toBeGreaterThan(
      w.timeline.indexOf(departures[1] ?? '')
    )
    expect(w.crew.seated.get(MINE)).toEqual([])
    expect(w.repository.byId(OTHER)?.state).toBe('active')
  })

  it('[US-MINES-006.AC09, S3.17, INV-06] when a dwarf could not be ended the mine stays with only that dwarf, the ended ones depart and one MineRemovalFailed names every failed dwarf', async () => {
    const w = world()
    const before = w.mine(MINE, 'alpha', ACTIVE, [BORIN, DAIN])
    w.crew.failing.add(DAIN)

    expect(await w.remove(MINE, REQUEST)).toEqual({
      ok: false,
      error: 'dwarf-could-not-be-ended'
    })

    // INV-06: the prior state, untouched; only the dwarf that could not be ended is left in it.
    expect(w.repository.byId(MINE)).toEqual(before)
    expect(w.crew.seated.get(MINE)).toEqual([DAIN])
    expect(w.timeline).toEqual([
      `abortWalk ${MINE}`,
      `endAllIn ${MINE}`,
      `DwarfDeparted ${BORIN} mine-removed`,
      'MineRemovalFailed'
    ])
    expect(w.bus.ofType('MineRemovalFailed').map((event) => event.payload)).toEqual([
      { mineId: MINE, requestId: REQUEST, failed: [DAIN] }
    ])
    expect(w.bus.ofType('MineRemoved')).toEqual([])
    expect(w.queries.list({ sortBy: 'name', direction: 'asc' }).map((m) => m.mineId)).toEqual([
      MINE
    ])
    expect(mapMarkerOf(w.repository.byId(MINE) as Mine)).not.toBeNull()
  })

  it('[US-MAP-004.AC02] a removed mine is not listed and has no marker', async () => {
    const w = world()
    w.mine(MINE, 'alpha', ACTIVE, [BORIN])
    w.mine(OTHER, 'beta', ACTIVE)

    await w.remove(MINE, REQUEST)

    expect(w.queries.list({ sortBy: 'name', direction: 'asc' }).map((m) => m.mineId)).toEqual([
      OTHER
    ])
    expect(w.queries.get(MINE)).toBeNull()
    expect(mapMarkerOf(w.repository.byId(MINE) as Mine)).toBeNull()
  })

  it("[US-MAP-004.AC03, INV-96] a removed mine's totals leave the listed mines while its ledger rows stay", async () => {
    const w = world()
    w.mine(MINE, 'alpha', ACTIVE, [BORIN])
    w.mine(OTHER, 'beta', ACTIVE)
    w.repository.credit(MINE, 'gold', 9_000)
    w.repository.credit(MINE, 'coal', 120)
    w.repository.credit(OTHER, 'copper', 40)

    await w.remove(MINE, REQUEST)

    // The ore order lists only the mines on the board: the removed mine's ore no longer counts.
    expect(w.queries.list({ sortBy: 'ore', direction: 'desc' }).map((m) => m.mineId)).toEqual([
      OTHER
    ])
    // INV-96: the ledger survives the removal untouched (PO #4; NFR-PERS-08).
    expect(w.repository.ledgerRows(MINE)).toBe(2)
  })

  it('[S3.15] a running scoring walk is aborted when removal starts', async () => {
    const w = world()
    w.mine(MINE, 'alpha', { state: 'measuring' }, [BORIN])

    await w.remove(MINE, REQUEST)

    expect(w.timeline.slice(0, 2)).toEqual([`abortWalk ${MINE}`, `endAllIn ${MINE}`])
    expect(w.repository.byId(MINE)?.state).toBe('removed')
    expect(w.remeasured).toEqual([])
  })

  it('[S3.17] a measuring mine whose removal failed keeps its state and gets its walk again', async () => {
    const w = world()
    w.mine(MINE, 'alpha', { state: 'measuring' }, [BORIN])
    w.crew.failing.add(BORIN)

    await w.remove(MINE, REQUEST)

    expect(w.repository.byId(MINE)?.state).toBe('measuring')
    expect(w.remeasured).toEqual([MINE])
  })

  it('[S3.16] removing a mine already removed ends nothing, writes nothing and publishes nothing', async () => {
    const w = world()
    const removed = w.mine(MINE, 'alpha', { ...ACTIVE, state: 'removed', removedAt: T0 })

    expect(await w.remove(MINE, REQUEST)).toEqual({ ok: true, value: undefined })

    expect(w.crew.calls).toEqual([])
    expect(w.timeline).toEqual([])
    expect(w.repository.byId(MINE)).toEqual(removed)
    expect(w.bus.published).toEqual([])
  })
})
