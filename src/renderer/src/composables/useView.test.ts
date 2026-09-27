import { beforeEach, describe, expect, it } from 'vitest'
import { restoreLaunchView, takeLaunchMine, useView } from './useView'

/*
 * Every test in this file kept its subject through #90 and changed the shape it
 * asserts: `state.view` was a `{ kind }` union in which an open mine REPLACED
 * the map or the browse, and the design's shell holds the two at once — one
 * mine beside one secondary panel. So `{ kind: 'map' }` became `area: 'map'`,
 * and `{ kind: 'mine', mineId }` became `mineId` alongside whatever area was
 * already showing.
 *
 * REMOVED, stated here rather than passing unseen: the assertions that opening
 * a mine LEFT the map or the browse (`expect(state.view).toEqual({ kind:
 * 'mine', mineId: 'm1' })` where the old area is gone). Nothing inherited that
 * coverage, because the behaviour itself is gone: the exclusive view is what
 * this change removes, and the tests below now pin the opposite.
 */
describe('useView', () => {
  beforeEach(() => {
    useView().clear()
  })

  it('starts on the map with no mine open', () => {
    const { state } = useView()
    expect(state).toEqual({ area: 'map', mineId: null })
  })

  it('is a module singleton shared by every caller', () => {
    const first = useView()
    const second = useView()
    first.openMine('m1')
    expect(second.state.mineId).toBe('m1')
  })

  it('opens a mine and closes it again', () => {
    const { state, openMine, closeMine } = useView()
    openMine('m1')
    expect(state.mineId).toBe('m1')
    closeMine()
    expect(state.mineId).toBeNull()
  })

  it('keeps the mine open while it still exists', () => {
    const { state, openMine, syncWithMines } = useView()
    openMine('m1')
    syncWithMines(['m0', 'm1', 'm2'])
    expect(state.mineId).toBe('m1')
  })

  it('lets go of the mine when it disappears from the board', () => {
    const { state, openMine, syncWithMines } = useView()
    openMine('m1')
    syncWithMines(['m0', 'm2'])
    expect(state.mineId).toBeNull()
  })

  it('leaves the map view untouched by refreshes', () => {
    const { state, syncWithMines } = useView()
    syncWithMines([])
    expect(state).toEqual({ area: 'map', mineId: null })
  })

  /* The browse over every project the app remembers, mines the board included (#92). */
  it('opens the mines list and returns to the map', () => {
    const { state, showMines, showMap } = useView()
    showMines()
    expect(state.area).toBe('mines')
    showMap()
    expect(state.area).toBe('map')
  })

  it('leaves the mines list open when the board changes under it', () => {
    // The list spans projects with no session running, so a mine leaving the
    // board says nothing about whether the browse is still worth showing.
    const { state, showMines, syncWithMines } = useView()
    showMines()
    syncWithMines([])
    expect(state.area).toBe('mines')
  })

  it('enters a mine straight from the list, and keeps the list behind it', () => {
    const { state, showMines, openMine } = useView()
    showMines()
    openMine('m1')
    expect(state).toEqual({ area: 'mines', mineId: 'm1' })
  })

  /*
   * The concurrent model the design's exports prove (#90): one mine plus one
   * secondary panel, and switching the secondary panel never costs you the mine.
   */
  it('keeps the mine open behind the map it was entered from', () => {
    const { state, openMine } = useView()
    openMine('m1')
    expect(state).toEqual({ area: 'map', mineId: 'm1' })
  })

  it('switches the secondary panel without closing the mine', () => {
    const { state, openMine, showArea } = useView()
    openMine('m1')
    for (const area of ['mines', 'lab', 'market', 'settings', 'map'] as const) {
      showArea(area)
      expect(state.mineId, area).toBe('m1')
    }
    expect(state.area).toBe('map')
  })

  it('closes the mine without touching the secondary panel', () => {
    const { state, showMines, openMine, closeMine } = useView()
    showMines()
    openMine('m1')
    closeMine()
    expect(state).toEqual({ area: 'mines', mineId: null })
  })

  it('replaces the open mine rather than stacking a second one', () => {
    // The design proves one mine beside one secondary panel and no more; the
    // source itself warns against assuming arbitrary multi-panel stacking.
    const { state, openMine } = useView()
    openMine('m1')
    openMine('m2')
    expect(state.mineId).toBe('m2')
  })
})

/* --- The launch view (#635, PANEL-QUESTIONS 25) — one block, appended ----- */
describe('restoreLaunchView (#635, PANEL-QUESTIONS 25)', () => {
  beforeEach(() => {
    useView().clear()
  })

  // AMENDED in this change (was: the mine opened at once): the mine waits for App to know its
  // folder is still there, so a gone one never opens and closes on screen.
  it('opens on the page main remembers, and holds its mine until App knows it still opens', async () => {
    await restoreLaunchView({
      getLaunchView: () => Promise.resolve({ area: 'mines', mineId: 'north-shaft' })
    })
    expect(useView().state).toEqual({ area: 'mines', mineId: null })
    expect(takeLaunchMine()).toBe('north-shaft')
    expect(takeLaunchMine()).toBeNull()
  })

  it('opens the default view when main remembers nothing', async () => {
    useView().showArea('settings')
    await restoreLaunchView({ getLaunchView: () => Promise.resolve({ area: 'map', mineId: null }) })
    expect(useView().state).toEqual({ area: 'map', mineId: null })
    expect(takeLaunchMine()).toBeNull()
  })

  it('reads what came back through the shared parser, so a stray answer opens the Map', async () => {
    await restoreLaunchView({
      getLaunchView: () => Promise.resolve({ area: 'vault', mineId: 7 } as never)
    })
    expect(useView().state).toEqual({ area: 'map', mineId: null })
  })

  it('opens the default view when the bridge cannot answer, never failing the launch', async () => {
    useView().showArea('settings')
    await expect(
      restoreLaunchView({ getLaunchView: () => Promise.reject(new Error('no handler')) })
    ).resolves.toBeUndefined()
    expect(useView().state).toEqual({ area: 'map', mineId: null })
  })
})
/* --- end of the #635 launch view block --------------------------------------- */
