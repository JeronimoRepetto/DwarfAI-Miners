import { describe, expect, it } from 'vitest'
import type { FolderPath, MineId } from '../../../kernel/domain/values'
import {
  mineIdOf,
  mineNameOf,
  openMine,
  transition,
  type Mine,
  type MineInput
} from '../domain/mine'
import { canonicalMinePath } from '../domain/minePath'
import { DEFAULT_TIER_THRESHOLDS } from '../domain/tier'
import { InMemoryMineRepository } from '../testing/InMemoryMineRepository'
import { MineReadModel } from './mineQueries'

// L2 (17 §1.2): `MinesQueries` over the repository double, which runs the same contract as the
// SQLite adapter.
const T0 = 1_790_000_000_000
const KB = 1024

let sequence = 0
const nextId = (): MineId =>
  mineIdOf(`00000000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`)

function declared(name: string, at: number): Mine {
  const mine = openMine(
    {
      cause: 'declared',
      birth: {
        id: nextId(),
        path: canonicalMinePath(`/work/${name}`, { style: 'posix', caseFold: false }),
        name: mineNameOf(name)
      }
    },
    at
  ).mine
  if (mine === null) throw new Error('fixture opening refused')
  return mine
}

function then(mine: Mine, input: MineInput, at = T0): Mine {
  const next = transition(mine, input, at).mine
  if (next === null) throw new Error(`fixture ${input.type} refused`)
  return next
}

const measured = (mine: Mine, kb: number): Mine =>
  then(mine, {
    type: 'measured',
    sourceWeight: { bytes: kb * KB },
    thresholds: DEFAULT_TIER_THRESHOLDS
  })

/** The Mines page world: four listed mines, one removed, and their crews and ore. */
function world() {
  let open = false
  const repository = new InMemoryMineRepository({
    scope: { isInTransaction: () => open },
    mapSites: [],
    random: () => 0
  })
  const save = (...mines: Mine[]) => {
    open = true
    try {
      for (const mine of mines) repository.save(mine)
    } finally {
      open = false
    }
  }
  const alpha = measured(declared('alpha', T0 + 3), 400)
  const bravo = measured(declared('Bravo', T0 + 1), 2_000)
  const charlie = declared('charlie', T0 + 4)
  const delta = measured(declared('delta', T0 + 2), 500)
  const echo = measured(declared('echo', T0 + 9), 3_000)
  save(alpha, bravo, charlie, delta, echo)
  save(
    then(then(echo, { type: 'removal-requested' }), {
      type: 'removal-settled',
      everyDwarfEnded: true
    })
  )
  repository.credit(alpha.id, 'gold', 10)
  repository.credit(bravo.id, 'uranium', 1)
  repository.credit(delta.id, 'gold', 10)
  repository.credit(delta.id, 'coal', 5)
  repository.seatDwarf(alpha.id, true)
  repository.seatDwarf(alpha.id, true)
  repository.seatDwarf(alpha.id, false)
  repository.seatDwarf(delta.id, true)
  const queries = new MineReadModel({ repository, presentDwarfs: repository })
  return { queries, alpha, bravo, charlie, delta, echo }
}

describe('MinesQueries (16 §4.1; 14 B-M19)', () => {
  it('[ADR-005] list filters by tier, searches by name, sorts by name, last used, tier or ore in both directions and pages with limit and offset', () => {
    const { queries, alpha, delta } = world()
    const names = (q: Parameters<typeof queries.list>[0]) => queries.list(q).map((m) => m.name)

    expect(queries.list({ sortBy: 'name', direction: 'asc', tier: 'copper' })).toEqual([
      {
        mineId: alpha.id,
        name: 'alpha',
        path: '/work/alpha',
        tier: 'copper',
        lastUsedAt: T0 + 3,
        presentDwarfs: 2,
        removed: false
      },
      {
        mineId: delta.id,
        name: 'delta',
        path: '/work/delta',
        tier: 'copper',
        lastUsedAt: T0 + 2,
        presentDwarfs: 1,
        removed: false
      }
    ])
    expect(names({ sortBy: 'name', direction: 'asc', nameContains: 'BRÁV' })).toEqual(['Bravo'])
    expect(names({ sortBy: 'name', direction: 'desc' })).toEqual([
      'delta',
      'charlie',
      'Bravo',
      'alpha'
    ])
    expect(names({ sortBy: 'lastUsed', direction: 'desc' })).toEqual([
      'charlie',
      'alpha',
      'delta',
      'Bravo'
    ])
    expect(names({ sortBy: 'tier', direction: 'desc' })).toEqual([
      'Bravo',
      'delta',
      'alpha',
      'charlie'
    ])
    expect(names({ sortBy: 'ore', direction: 'asc' })).toEqual([
      'charlie',
      'alpha',
      'delta',
      'Bravo'
    ])
    expect(names({ sortBy: 'name', direction: 'asc', limit: 2, offset: 1 })).toEqual([
      'Bravo',
      'charlie'
    ])
    expect(
      queries.list({ sortBy: 'name', direction: 'asc', offset: 2 }).map((m) => m.presentDwarfs)
    ).toEqual([0, 1])
  })

  it('[INV-06] get and folderOf read one mine on the board; a removed or unknown mine reads as none', () => {
    const { queries, alpha, echo } = world()

    expect(queries.get(alpha.id)).toMatchObject({
      id: alpha.id,
      name: 'alpha',
      state: 'active',
      tier: 'copper',
      presentDwarfs: 2
    })
    expect(queries.folderOf(alpha.id)).toBe('/work/alpha' as FolderPath)
    expect(queries.get(echo.id)).toBeNull()
    expect(queries.folderOf(echo.id)).toBeNull()
    expect(queries.get(nextId())).toBeNull()
    expect(queries.folderOf(nextId())).toBeNull()
  })
})
