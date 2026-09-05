import { describe, expect, it } from 'vitest'
import { defaultMine, defaultProject } from '../../testing/factories'
import { mapMines } from './mapPopulation'

/*
 * The map used to draw `state.mines` alone (#197): this poll's live board, plus
 * whatever `mergeDeclaredMines` already folded in for a DECLARED project with
 * no session running. A project the app has merely discovered before — no
 * declaration, no session today — has a row in the Mines list (`browseRows`,
 * lib/browse/boardRows.ts) but never reached the board, so it never reached the
 * map either. The third acceptance run's #165 fix closed exactly this gap the
 * other direction (an undeclared LIVE mine with no store row); this closes it
 * for an undeclared project with no LIVE mine.
 */
describe('mapMines', () => {
  it('draws every live mine unchanged', () => {
    const mine = defaultMine({ id: 'C:/dev/live', name: 'live' })
    expect(mapMines([mine], [])).toEqual([mine])
  })

  it('draws a marker-ready mine for a remembered project with no live session', () => {
    const project = defaultProject({
      id: 'C:/dev/idle',
      path: 'C:/dev/idle',
      name: 'idle',
      knownTier: 'gold',
      mapSite: 12
    })
    const result = mapMines([], [project])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'C:/dev/idle',
      name: 'idle',
      path: 'C:/dev/idle',
      tier: 'gold',
      dwarfs: [],
      tokensObserved: 0,
      mapSite: 12
    })
  })

  /*
   * `tierOf()`'s own rule (#41), reapplied here: a project no walk has measured
   * is drawn at bronze, a placeholder that never gets sealed anywhere — nothing
   * in this module writes a decision down.
   */
  it('falls back to bronze for a project no walk has measured', () => {
    const project = defaultProject({ id: 'C:/dev/unwalked', name: 'unwalked' })
    const result = mapMines([], [project])
    expect(result[0]!.tier).toBe('bronze')
  })

  /*
   * The second half of #197: a project both on the board right now AND
   * remembered by the store must still be ONE mine, never a live marker plus a
   * synthesized idle one standing beside it.
   */
  it('never doubles a project that is both live and remembered', () => {
    const mine = defaultMine({ id: 'C:/dev/both', name: 'both', tier: 'silver' })
    const project = defaultProject({ id: 'C:/dev/both', name: 'both', knownTier: 'bronze' })
    const result = mapMines([mine], [project])
    expect(result).toHaveLength(1)
    // The live reading wins — same discipline mergeDeclaredMines already uses.
    expect(result[0]).toEqual(mine)
  })

  it('leaves an unrecorded live mine alone: it is already on the board', () => {
    const mine = defaultMine({ id: 'C:/dev/valley', name: 'valley', unrecorded: true })
    expect(mapMines([mine], [])).toEqual([mine])
  })
})
