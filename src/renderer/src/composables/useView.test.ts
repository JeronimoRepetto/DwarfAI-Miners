import { beforeEach, describe, expect, it } from 'vitest'
import { useView } from './useView'

describe('useView', () => {
  beforeEach(() => {
    useView().clear()
  })

  it('starts on the map', () => {
    const { state } = useView()
    expect(state.view).toEqual({ kind: 'map' })
  })

  it('is a module singleton shared by every caller', () => {
    const first = useView()
    const second = useView()
    first.openMine('m1')
    expect(second.state.view).toEqual({ kind: 'mine', mineId: 'm1' })
  })

  it('opens a mine and returns to the map', () => {
    const { state, openMine, showMap } = useView()
    openMine('m1')
    expect(state.view).toEqual({ kind: 'mine', mineId: 'm1' })
    showMap()
    expect(state.view).toEqual({ kind: 'map' })
  })

  it('keeps the mine view while the mine still exists', () => {
    const { state, openMine, syncWithMines } = useView()
    openMine('m1')
    syncWithMines(['m0', 'm1', 'm2'])
    expect(state.view).toEqual({ kind: 'mine', mineId: 'm1' })
  })

  it('falls back to the map when the open mine disappears', () => {
    const { state, openMine, syncWithMines } = useView()
    openMine('m1')
    syncWithMines(['m0', 'm2'])
    expect(state.view).toEqual({ kind: 'map' })
  })

  it('leaves the map view untouched by refreshes', () => {
    const { state, syncWithMines } = useView()
    syncWithMines([])
    expect(state.view).toEqual({ kind: 'map' })
  })

  /* The browse over every project the app remembers, mines the board included (#92). */
  it('opens the mines list and returns to the map', () => {
    const { state, showMines, showMap } = useView()
    showMines()
    expect(state.view).toEqual({ kind: 'mines' })
    showMap()
    expect(state.view).toEqual({ kind: 'map' })
  })

  it('leaves the mines list open when the board changes under it', () => {
    // The list spans projects with no session running, so a mine leaving the
    // board says nothing about whether the browse is still worth showing.
    const { state, showMines, syncWithMines } = useView()
    showMines()
    syncWithMines([])
    expect(state.view).toEqual({ kind: 'mines' })
  })

  it('enters a mine straight from the list', () => {
    const { state, showMines, openMine } = useView()
    showMines()
    openMine('m1')
    expect(state.view).toEqual({ kind: 'mine', mineId: 'm1' })
  })
})
