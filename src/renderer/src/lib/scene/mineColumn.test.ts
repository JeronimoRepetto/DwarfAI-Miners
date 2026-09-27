import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import { INTERIOR_STATIONS } from './interiorMap'
import { assignScene } from './sceneAssignment'
import { sceneLayout } from './sceneLayout'
import { ADD_DWARF_LABEL, interiorLabel, mineColumnLabel, mineCrew, mineStands } from './mineColumn'

describe('the mine column copy', () => {
  it('names the region "Mine <name>" and the art "<name> interior"', () => {
    expect(mineColumnLabel('DwarfAI-Miners')).toBe('Mine DwarfAI-Miners')
    expect(interiorLabel('AI-Tools')).toBe('AI-Tools interior')
    expect(ADD_DWARF_LABEL).toBe('+ Dwarf')
  })
})

describe('mineCrew', () => {
  /*
   * One sprite per dwarf (#165): the board is assembled from several sources and two of them can
   * name one session, which put a dwarf in the list twice and drew two halos for one selection.
   * The first listing wins, so a dwarf does not change with whichever source spoke last.
   */
  it('keeps one entry per dwarf id, the first listing winning', () => {
    const mine = defaultMine({
      dwarfs: [
        defaultDwarf({ id: 'a', name: 'first' }),
        defaultDwarf({ id: 'b' }),
        defaultDwarf({ id: 'a', name: 'second' })
      ]
    })
    const crew = mineCrew(mine)
    expect(crew.map((d) => d.id)).toEqual(['a', 'b'])
    expect(crew[0]!.name).toBe('first')
  })
})

describe('mineStands', () => {
  const crew = [
    defaultDwarf({ id: 'w1', role: 'worker', status: 'working' }),
    defaultDwarf({ id: 'f1', role: 'foreman', status: 'waiting' }),
    defaultDwarf({ id: 'w2', role: 'worker2', status: 'working' })
  ]

  /*
   * Stations are image percent of the painting (coordinates rule), and the art box carries the
   * painting's own aspect (components.md, Mine column), so a station's image percent IS its box
   * percent: nothing is projected or clamped.
   */
  it('stands each dwarf on the station the scene assigns it, in image percent', () => {
    const placements = assignScene(crew, sceneLayout('silver'))
    for (const stand of mineStands(crew, 'silver')) {
      const placed = placements.get(stand.dwarf.id)!
      expect({ x: stand.x, y: stand.y, facesLeft: stand.facesLeft }).toEqual({
        x: placed.point.x,
        y: placed.point.y,
        facesLeft: placed.facesLeft
      })
    }
  })

  // A nearer gallery paints over a farther one, in DOM order as in z-index (depthOrder).
  /*
   * AMENDED for #635 (was: "paints them high to low, ties broken by id"). The design draws the
   * crew in the board's order, every dwarf at the one z-index (anatomy.md, Mine column: d53, d54,
   * d55, d56 whatever their galleries; components.md, Dwarf: z-index 2). The board's order is
   * already stable across polls (mineCrew), which is what the id tie-break was for.
   */
  it('stands them in the crew’s own order, whatever their galleries', () => {
    const stands = mineStands(crew, 'silver')
    expect(stands.map((s) => s.dwarf.id)).toEqual(crew.map((d) => d.id))
  })

  /*
   * AMENDED for #635 (PANEL-QUESTIONS 14; was: "keeps a leaving dwarf, and everyone else, on the
   * station it had"): today's walk is restored, so a leaving dwarf is sent to a spawn point and
   * walks out to it. RESTORED from MineScene.test.ts (88ee3fc): "sends a leaving dwarf to a spawn
   * point rather than fading in place".
   */
  it('sends a leaving dwarf to a spawn point rather than fading in place', () => {
    const working = mineStands(crew, 'silver').find((s) => s.dwarf.id === 'w1')!
    const leaving = mineStands(
      crew.map((d) => (d.id === 'w1' ? { ...d, status: 'leaving' as const } : d)),
      'silver'
    ).find((s) => s.dwarf.id === 'w1')!
    expect([leaving.x, leaving.y]).not.toEqual([working.x, working.y])
    const spawns = INTERIOR_STATIONS.filter((station) => station.kind === 'spawn')
    expect(spawns.map((s) => [s.x, s.y])).toContainEqual([leaving.x, leaving.y])
  })

  // The caller may name each dwarf's station itself, as the design's own sample does.
  it('takes a station the caller names over the one the scene would assign', () => {
    const stands = mineStands(crew, 'silver', { w1: { x: 61.83, y: 24.94, facesLeft: false } })
    expect(stands.find((s) => s.dwarf.id === 'w1')).toMatchObject({
      x: 61.83,
      y: 24.94,
      facesLeft: false
    })
  })
})
