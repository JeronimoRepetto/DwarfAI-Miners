import { describe, expect, it } from 'vitest'
import { defaultMaterials, defaultMine } from '../testing/factories'
import { useMines } from './useMines'

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
