import { describe, expect, it } from 'vitest'
import { columnMine, launchMineOpens, openableMineIds } from './columnMine'
import { defaultDwarf, defaultMine, defaultProject } from '../../testing/factories'

/*
 * #635, PANEL-QUESTIONS 5 (design lead ruling 2026-09-27): a remembered mine with no dwarf and no
 * live session opens like any other card, onto the mine column's empty roster and + Dwarf. The
 * board does not carry it, so the column is drawn from the store row the card was built from.
 */
describe('columnMine', () => {
  it('draws the board’s mine when the board has it', () => {
    const mine = defaultMine({ id: 'a', dwarfs: [defaultDwarf()] })
    expect(columnMine('a', [mine], [defaultProject({ id: 'a', live: true })])).toBe(mine)
  })

  it('draws a remembered mine the board does not carry, with no crew', () => {
    const project = defaultProject({ id: 'r', path: 'C:/dev/r', name: 'r', knownTier: 'gold' })
    expect(columnMine('r', [], [project])).toEqual({
      id: 'r',
      path: 'C:/dev/r',
      name: 'r',
      tier: 'gold',
      dwarfs: [],
      tokensObserved: 0,
      updatedAt: 0
    })
  })

  it('draws an unmeasured one on the Bronze placeholder, and carries its ore when it has some', () => {
    const materials = { coal: 1, bronze: 0, copper: 0, silver: 0, gold: 0, uranium: 0 }
    const drawn = columnMine('r', [], [defaultProject({ id: 'r', materials })])
    expect(drawn?.tier).toBe('bronze')
    expect(drawn?.materials).toEqual(materials)
  })

  it('draws nothing for a missing folder, which is not enterable, or for an unknown id', () => {
    expect(columnMine('r', [], [defaultProject({ id: 'r', folderMissing: true })])).toBeUndefined()
    expect(columnMine('nowhere', [], [defaultProject({ id: 'r' })])).toBeUndefined()
  })
})

describe('openableMineIds', () => {
  it('holds every board mine and every remembered mine whose folder is there', () => {
    const ids = openableMineIds(
      [defaultMine({ id: 'a' })],
      [defaultProject({ id: 'r' }), defaultProject({ id: 'gone', folderMissing: true })]
    )
    expect([...ids].sort()).toEqual(['a', 'r'])
  })
})

/* APPENDED for #635 (PANEL-QUESTIONS 25): whether the mine the app last closed on opens again. */
describe('launchMineOpens', () => {
  it('opens a board mine, and a remembered one whose folder is there', () => {
    expect(launchMineOpens('a', [defaultMine({ id: 'a' })], [])).toBe(true)
    expect(launchMineOpens('r', [], [defaultProject({ id: 'r' })])).toBe(true)
  })

  it('opens nothing for a mine whose folder is gone, even while a session still puts it on the board', () => {
    const gone = [defaultProject({ id: 'a', folderMissing: true })]
    expect(launchMineOpens('a', [defaultMine({ id: 'a' })], gone)).toBe(false)
    expect(launchMineOpens('a', [], gone)).toBe(false)
  })

  it('opens nothing for a mine that was removed', () => {
    expect(launchMineOpens('gone', [defaultMine({ id: 'a' })], [defaultProject({ id: 'r' })])).toBe(
      false
    )
  })
})
