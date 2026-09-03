import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMaterials, defaultMine } from '../../testing/factories'
import type { Mine, ProjectSummary } from '../../types'
import { browseRows, unrecordedRows } from './boardRows'

function mine(overrides: Partial<Mine> = {}): Mine {
  return defaultMine({ id: 'mine:a', path: 'C:/dev/alpha', name: 'alpha', ...overrides })
}

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'mine:a',
    path: 'C:/dev/alpha',
    name: 'alpha',
    declared: false,
    addedAt: 0,
    live: false,
    ...overrides
  }
}

const ALL = { search: '', tier: null }

describe('unrecordedRows', () => {
  it('builds a row for a board mine the store has no row for', () => {
    const rows = unrecordedRows([mine({ unrecorded: true })], [], ALL)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'mine:a',
      path: 'C:/dev/alpha',
      name: 'alpha',
      live: true,
      unrecorded: true
    })
  })

  it('claims none of the facts only a store row can carry', () => {
    // Everything the mine is drawn with on the map — its provisional tier above
    // all (#41) — stays off the card. An unrecorded row says what the BOARD can
    // see and nothing else, which is why it is not a project summary main sent.
    const [row] = unrecordedRows(
      [mine({ unrecorded: true, tier: 'gold', materials: defaultMaterials({ coal: 5 }) })],
      [],
      ALL
    )

    expect(row!.knownTier).toBeUndefined()
    expect(row!.weightBytes).toBeUndefined()
    expect(row!.materials).toBeUndefined()
    expect(row!.declared).toBe(false)
  })

  it('leaves a mine main did not flag alone', () => {
    // Absent is not false: a store that never answered says nothing about any
    // mine, and listing the whole board again is exactly what that must not do.
    expect(unrecordedRows([mine()], [], ALL)).toEqual([])
  })

  it('drops a mine the listed page already carries', () => {
    // The store's own row is the better card, and two cards for one project is
    // the disagreement running the other way.
    expect(unrecordedRows([mine({ unrecorded: true })], [project()], ALL)).toEqual([])
  })

  it('matches the typed search against the name, folded as the store folds it', () => {
    const board = [mine({ unrecorded: true, name: 'Cafetería-Ñandú' })]

    expect(unrecordedRows(board, [], { search: 'cafeteria', tier: null })).toHaveLength(1)
    expect(unrecordedRows(board, [], { search: 'ontein', tier: null })).toEqual([])
  })

  it('appears under no tier chip but All', () => {
    // An unrecorded mine has no measured tier, so it can claim none — the same
    // rule an unmeasured stored project already lives under (#92).
    const board = [mine({ unrecorded: true, tier: 'bronze' })]

    expect(unrecordedRows(board, [], { search: '', tier: 'bronze' })).toEqual([])
    expect(unrecordedRows(board, [], ALL)).toHaveLength(1)
  })

  it('carries the live crew, which is the one count the board can back', () => {
    const board = [mine({ unrecorded: true, dwarfs: [defaultDwarf({ id: 'd1' })] })]

    expect(unrecordedRows(board, [], ALL)[0]!.live).toBe(true)
  })
})

describe('browseRows', () => {
  it('puts every unrecorded mine in front of the answered page', () => {
    // They are the freshest thing the panel holds — a session working right now
    // — and the page behind them is ordered by the date each was added.
    const rows = browseRows(
      [project({ id: 'mine:b', name: 'beta' })],
      [mine({ unrecorded: true })],
      ALL
    )

    expect(rows.map((row) => row.id)).toEqual(['mine:a', 'mine:b'])
    expect(rows[0]!.unrecorded).toBe(true)
    expect(rows[1]!.unrecorded).toBeUndefined()
  })

  it('is the answered page itself when the board adds nothing', () => {
    const page = [project()]
    expect(browseRows(page, [mine()], ALL).map((row) => row.id)).toEqual(['mine:a'])
  })

  it('gives every mine on the map a row in the list', () => {
    // The coherence rule, stated as the test that proves it: one world.
    const board = [
      mine({ id: 'mine:a', unrecorded: true }),
      mine({ id: 'mine:b', name: 'beta' }),
      mine({ id: 'mine:c', name: 'gamma', unrecorded: true })
    ]
    const page = [project({ id: 'mine:b', name: 'beta' })]

    const listed = new Set(browseRows(page, board, ALL).map((row) => row.id))
    expect(board.every((entry) => listed.has(entry.id))).toBe(true)
  })
})
