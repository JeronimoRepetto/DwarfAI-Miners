// layer: L2
// L2 (17 §1.2): the `AskQueries` read model (05 §3.7; 16 §4.7) over the `InMemoryAskRepository`
// and a crew double: the open asks for the snapshot's `asks` section and the needs-you queue
// (14 §4.1; 06 §0.2 `NeedsYouQueue`; ADR-032 D6; owner amendment L).
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { CrewQueries } from '../../crew'
import type { Ask } from '../domain/ask'
import { InMemoryAskRepository } from '../ports/fakes/InMemoryAskRepository'
import { permissionAsk, questionAsk } from '../testing/askRepository.contract'
import { AskReadModel } from './askQueries'

const T0 = 1_790_000_000_000
const DWARF_A = '00000000-0000-7000-8000-0000000130a1' as DwarfId
const DWARF_B = '00000000-0000-7000-8000-0000000130b1' as DwarfId
const DWARF_C = '00000000-0000-7000-8000-0000000130c1' as DwarfId
const MINE_1 = '00000000-0000-7000-8000-0000000130f1' as MineId
const MINE_2 = '00000000-0000-7000-8000-0000000130f2' as MineId

/** Crew's `get`, reduced to the one field the queue reads: the dwarf's mine. */
function crewOn(mines: Record<string, MineId>): Pick<CrewQueries, 'get'> {
  return {
    get: (dwarfId) =>
      mines[dwarfId] === undefined
        ? null
        : ({ id: dwarfId, mineId: mines[dwarfId] } as ReturnType<CrewQueries['get']>)
  }
}

function readModel(asks: Ask[]) {
  const repository = new InMemoryAskRepository()
  for (const ask of asks) repository.save(ask)
  return {
    repository,
    queries: new AskReadModel({
      asks: repository,
      crew: crewOn({ [DWARF_A]: MINE_1, [DWARF_B]: MINE_2, [DWARF_C]: MINE_1 })
    })
  }
}

describe('AskQueries (05 §3.7; 16 §4.7; owner amendment L)', () => {
  it('[ADR-010] openAsks lists every open or answering ask oldest first, queued asks included, and never a closed one', () => {
    const queuedA = questionAsk(1, DWARF_A, { openedAt: T0 + 300 })
    const frontB = permissionAsk(2, DWARF_B, { openedAt: T0 + 200, state: 'answering' })
    const frontA = permissionAsk(3, DWARF_A, { openedAt: T0 + 100 })
    const closedC = permissionAsk(4, DWARF_C, { state: 'cancelled', closedAt: T0 + 5 })
    const { queries } = readModel([queuedA, frontB, frontA, closedC])

    expect(queries.openAsks()).toStrictEqual([frontA, frontB, queuedA])
    expect(queries.snapshot().asks).toStrictEqual([frontA, frontB, queuedA])
  })

  it('[ADR-032] the needs-you queue holds one entry per dwarf with an open ask, on its mine, ordered by the openedAt of its oldest ask', () => {
    // Saved newest first; the ids run against openedAt, so only openedAt can give this order.
    const queuedA = questionAsk(1, DWARF_A, { openedAt: T0 + 400 })
    const frontC = permissionAsk(2, DWARF_C, { openedAt: T0 + 300 })
    const frontB = permissionAsk(3, DWARF_B, { openedAt: T0 + 200, state: 'answering' })
    const frontA = permissionAsk(4, DWARF_A, { openedAt: T0 + 100 })
    const { queries } = readModel([queuedA, frontC, frontB, frontA])

    expect(queries.snapshot().needsYou).toStrictEqual([
      { dwarfId: DWARF_A, mineId: MINE_1, askedAt: T0 + 100 },
      { dwarfId: DWARF_B, mineId: MINE_2, askedAt: T0 + 200 },
      { dwarfId: DWARF_C, mineId: MINE_1, askedAt: T0 + 300 }
    ])
  })

  it("[ADR-010] openAskOf answers the dwarf's front ask, open or answering, and null once its asks closed", () => {
    const front = permissionAsk(1, DWARF_A, { openedAt: T0 + 100 })
    const queued = questionAsk(2, DWARF_A, { openedAt: T0 + 200 })
    const { repository, queries } = readModel([queued, front])

    expect(queries.openAskOf(DWARF_A)).toStrictEqual(front)
    repository.save({ ...front, state: 'answering' })
    expect(queries.openAskOf(DWARF_A)).toStrictEqual({ ...front, state: 'answering' })
    repository.save({ ...front, state: 'answered-in-app', closedAt: T0 + 250 })
    expect(queries.openAskOf(DWARF_A)).toStrictEqual(queued)
    repository.save({ ...queued, state: 'closed-by-death', closedAt: T0 + 260 })
    expect(queries.openAskOf(DWARF_A)).toBeNull()
    expect(queries.openAskOf(DWARF_B)).toBeNull()
    expect(queries.snapshot()).toStrictEqual({ asks: [], needsYou: [] })
  })
})
