import { describe, expect, it } from 'vitest'
import { defaultMine } from '../testing/factories'
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
