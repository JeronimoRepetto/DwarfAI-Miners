import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMaterials, defaultMine } from '../testing/factories'
import { useMines } from './useMines'

/*
 * WHO IS NEW ON THE BOARD (#156).
 *
 * The mine's interior walks an arriving dwarf in from a spawn point, and it used
 * to decide who had arrived from its own first snapshot. That cannot see the one
 * case the acceptance run found: a mine nobody is working is not on the board at
 * all, so its interior is not mounted — launch the first agent and the scene
 * mounts with that agent already in it, which its own first snapshot reads as
 * "was already at work before anybody looked". The maintainer's first foreman
 * materialised on the spot; his second walked, because by then the interior had
 * been open long enough to see the mine empty.
 *
 * The panel has been polling the whole time and does know. This is that fact,
 * held where every consumer can read it: the dwarfs on this snapshot that were
 * not on the one before it.
 */
describe('useMines arrivals', () => {
  const crew = (...ids: string[]) => ids.map((id) => defaultDwarf({ id }))

  it('reports nobody as arriving on the first snapshot it ever sees', () => {
    // Everything running when the panel starts was already running. Calling
    // that an arrival would parade the whole valley across its interiors.
    const { state, setMines, clear } = useMines()
    clear()
    setMines({ mines: [defaultMine({ dwarfs: crew('a', 'b') })], tokensObserved: 0 })
    expect([...state.arrived]).toEqual([])
  })

  it('reports the dwarfs that were not on the snapshot before', () => {
    const { state, setMines, clear } = useMines()
    clear()
    setMines({ mines: [defaultMine({ dwarfs: crew('a') })], tokensObserved: 0 })
    setMines({ mines: [defaultMine({ dwarfs: crew('a', 'b') })], tokensObserved: 0 })
    expect([...state.arrived]).toEqual(['b'])
  })

  it('reports an arrival into a mine that had nobody in it', () => {
    // The reproduction: the mine is not on the board at all until a session
    // starts in it, so the arrival brings the mine with it.
    const { state, setMines, clear } = useMines()
    clear()
    setMines({ mines: [], tokensObserved: 0 })
    setMines({ mines: [defaultMine({ dwarfs: crew('a') })], tokensObserved: 0 })
    expect([...state.arrived]).toEqual(['a'])
  })

  it('stops calling a dwarf new once it has been on a snapshot', () => {
    const { state, setMines, clear } = useMines()
    clear()
    setMines({ mines: [], tokensObserved: 0 })
    setMines({ mines: [defaultMine({ dwarfs: crew('a') })], tokensObserved: 0 })
    setMines({ mines: [defaultMine({ dwarfs: crew('a') })], tokensObserved: 0 })
    expect([...state.arrived]).toEqual([])
  })

  it('forgets who was there when the board is cleared', () => {
    // A cleared board is a panel that has stopped looking; what it sees next is
    // a first snapshot again, not a valley of arrivals.
    const { state, setMines, clear } = useMines()
    setMines({ mines: [defaultMine({ dwarfs: crew('a') })], tokensObserved: 0 })
    clear()
    setMines({ mines: [defaultMine({ dwarfs: crew('a', 'b') })], tokensObserved: 0 })
    expect([...state.arrived]).toEqual([])
  })
})

describe('useMines', () => {
  it('stores the mines list and vault total from a snapshot', () => {
    const { state, setMines } = useMines()
    const mine = defaultMine({ tokensObserved: 500 })
    setMines({ mines: [mine], tokensObserved: 500 })
    expect(state.mines).toEqual([mine])
    expect(state.tokensObserved).toBe(500)
  })

  it('clears both the mines list and the vault total', () => {
    const { state, setMines, clear } = useMines()
    setMines({ mines: [defaultMine()], tokensObserved: 42 })
    clear()
    expect(state.mines).toEqual([])
    expect(state.tokensObserved).toBe(0)
  })
})

/*
 * The global vault (see #22) travels on the same snapshot. It is deliberately
 * NOT the sum of the mines in the list: main sums it over the entire persisted
 * ledger, so it includes projects with no crew today — which is the only place
 * backfilled coal can appear.
 */
describe('useMines global vault', () => {
  it('stores the whole-ledger breakdown the snapshot carries', () => {
    const { state, setMines } = useMines()
    const materials = defaultMaterials({ coal: 500_000 })
    setMines({ mines: [], tokensObserved: 0, materials })
    expect(state.materials).toEqual(materials)
  })

  it('carries an absent breakdown through as absent rather than inventing one', () => {
    const { state, setMines } = useMines()
    setMines({ mines: [], tokensObserved: 0, materials: defaultMaterials({ gold: 100_000 }) })
    setMines({ mines: [], tokensObserved: 0 })
    expect(state.materials).toBeUndefined()
  })

  it('clears the vault breakdown along with the rest', () => {
    const { state, setMines, clear } = useMines()
    setMines({ mines: [], tokensObserved: 42, materials: defaultMaterials({ bronze: 20_000 }) })
    clear()
    expect(state.materials).toBeUndefined()
  })
})
