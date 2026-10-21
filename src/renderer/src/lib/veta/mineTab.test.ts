import { describe, expect, it } from 'vitest'
import {
  PLAIN_MINE_TAB,
  aimOf,
  stepMineTab,
  tabBand,
  type MineTab,
  type MineTabContext,
  type MineTabEvent,
  type MineTabStep
} from './mineTab'
import { EREBOR, KHAZAD, MORIA } from './testing/vetaFixtures'

/*
 * ISSUE-289 (TC-289-01, TC-289-02): 07 machine 23, the chamber hover and its mine tab, pure. Each step is named by its
 * 07 id; a step 07 does not list is rejected and the machine is held. The tab's band, the room it rises into that the
 * window always holds (07 §24 I-22), is worked out from the tabs' boxes alone.
 */

const DRAWN: MineTabContext = {
  life: 'sessions-working',
  dragging: false,
  drawn: [MORIA, EREBOR]
}

/** Runs events from a machine, collecting each step. */
function run(
  events: readonly MineTabEvent[],
  context: MineTabContext = DRAWN,
  from: MineTab = PLAIN_MINE_TAB
): { machine: MineTab; steps: MineTabStep[] } {
  let machine = from
  const steps: MineTabStep[] = []
  for (const event of events) {
    const next = stepMineTab(machine, event, context)
    machine = next.machine
    steps.push(next.step)
  }
  return { machine, steps }
}

const ids = (steps: readonly MineTabStep[]): Array<string | null> =>
  steps.map((step) => (step.ok ? step.id : null))

describe('machine 23 diagram conformance', () => {
  it('[US-VETA-004.AC01, US-VETA-004.AC02, S23.01] a tab rises only on hover or focus of a drawn chamber', () => {
    // No hover, no focus: no tab.
    expect(PLAIN_MINE_TAB).toEqual({ state: 'plain', mineId: null })
    expect(aimOf(null, null)).toBeNull()
    // Hover, or keyboard focus, aims at one chamber; hover wins over a focus elsewhere.
    expect(aimOf(MORIA, null)).toBe(MORIA)
    expect(aimOf(null, EREBOR)).toBe(EREBOR)
    expect(aimOf(MORIA, EREBOR)).toBe(MORIA)

    const hovered = run([{ type: 'aim', mineId: MORIA }])
    expect(ids(hovered.steps)).toEqual(['S23.01'])
    expect(hovered.machine).toEqual({ state: 'risen', mineId: MORIA })
    expect(hovered.steps[0]).toMatchObject({ from: 'plain', to: 'risen', effects: [] })

    // Guards: a chamber not drawn (folded into "+N"), and a drag under way, raise nothing.
    expect(run([{ type: 'aim', mineId: KHAZAD }]).machine).toEqual(PLAIN_MINE_TAB)
    expect(run([{ type: 'aim', mineId: MORIA }], { ...DRAWN, dragging: true }).machine).toEqual(
      PLAIN_MINE_TAB
    )
  })

  it('[US-VETA-004.AC06, S23.02] moving to another chamber folds the first tab and raises the other; never two', () => {
    const moved = run([
      { type: 'aim', mineId: MORIA },
      { type: 'aim', mineId: EREBOR }
    ])
    expect(ids(moved.steps)).toEqual(['S23.01', 'S23.02'])
    // One machine, one mine: the tab of MORIA folded as EREBOR's rose.
    expect(moved.machine).toEqual({ state: 'risen', mineId: EREBOR })
    expect(moved.steps[1]).toMatchObject({ from: 'risen', to: 'risen', effects: [] })
  })

  it('[US-VETA-004.AC05, S23.03] leaving the chamber or its focus folds the tab with no other effect', () => {
    const left = run([
      { type: 'aim', mineId: MORIA },
      { type: 'aim', mineId: null }
    ])
    expect(ids(left.steps)).toEqual(['S23.01', 'S23.03'])
    expect(left.machine).toEqual(PLAIN_MINE_TAB)
    expect(left.steps[1]).toMatchObject({ from: 'risen', to: 'plain', effects: [] })
  })

  it('[S23.07, S23.08, S23.09] the tab goes with its chamber, closes on a drag start, and never shows in first-run or no-sessions', () => {
    // S23.07: its chamber closed, folded into "+N", or its mine removed.
    const gone = run([{ type: 'aim', mineId: MORIA }, { type: 'drawn' }])
    expect(ids(gone.steps)).toEqual(['S23.01', null])
    const closed = stepMineTab(gone.machine, { type: 'drawn' }, { ...DRAWN, drawn: [EREBOR] })
    expect(closed.step).toMatchObject({ ok: true, id: 'S23.07', from: 'risen', to: 'plain' })
    expect(closed.machine).toEqual(PLAIN_MINE_TAB)

    // S23.08: a drag starts.
    const dragged = run([{ type: 'aim', mineId: EREBOR }, { type: 'drag-start' }])
    expect(ids(dragged.steps)).toEqual(['S23.01', 'S23.08'])
    expect(dragged.machine).toEqual(PLAIN_MINE_TAB)

    // S23.09: no chamber, no tab.
    for (const life of ['first-run', 'no-sessions'] as const) {
      const closedVeta = run([{ type: 'aim', mineId: MORIA }], { ...DRAWN, life })
      expect(ids(closedVeta.steps)).toEqual(['S23.09'])
      expect(closedVeta.machine).toEqual(PLAIN_MINE_TAB)
    }
  })

  it('[US-VETA-004.AC03, US-VETA-004.AC04, US-VETA-004.AC07, S23.04, S23.05, S23.06] Open and New dwarf act on the risen mine; a chamber body click does nothing', () => {
    const opened = run([{ type: 'aim', mineId: MORIA }, { type: 'open' }])
    expect(ids(opened.steps)).toEqual(['S23.01', 'S23.04'])
    expect(opened.steps[1]).toMatchObject({
      to: 'plain',
      effects: [{ kind: 'move', mode: 'panel', mineId: MORIA }]
    })
    const added = run([{ type: 'aim', mineId: EREBOR }, { type: 'add' }])
    expect(ids(added.steps)).toEqual(['S23.01', 'S23.05'])
    expect(added.steps[1]).toMatchObject({
      to: 'plain',
      effects: [{ kind: 'add-panel', mineId: EREBOR }]
    })
    const body = run([{ type: 'body-click' }])
    expect(ids(body.steps)).toEqual(['S23.06'])
    expect(body.steps[0]).toMatchObject({ from: 'plain', to: 'plain', effects: [] })
  })

  it('[ADR-025] a transition not listed in 07 machine 23 is rejected', () => {
    const risen: MineTab = { state: 'risen', mineId: MORIA }
    // The same events from the states 07 lists them in are taken: only the unlisted pairs below are refused.
    expect(stepMineTab(risen, { type: 'open' }, DRAWN).step.ok).toBe(true)
    expect(stepMineTab(risen, { type: 'aim', mineId: null }, DRAWN).step.ok).toBe(true)
    const rejected: Array<[MineTab, MineTabEvent]> = [
      // No tab to act on.
      [PLAIN_MINE_TAB, { type: 'open' }],
      [PLAIN_MINE_TAB, { type: 'add' }],
      // Nothing to fold.
      [PLAIN_MINE_TAB, { type: 'aim', mineId: null }],
      [PLAIN_MINE_TAB, { type: 'drag-start' }],
      [PLAIN_MINE_TAB, { type: 'drawn' }],
      // Already risen on that mine; its chamber still drawn.
      [risen, { type: 'aim', mineId: MORIA }],
      [risen, { type: 'drawn' }],
      // A drawn chamber only, no drag: a move onto a chamber folded into "+N" is not S23.02.
      [risen, { type: 'aim', mineId: KHAZAD }]
    ]
    for (const [machine, event] of rejected) {
      const next = stepMineTab(machine, event, DRAWN)
      expect(next.step, `${machine.state} + ${event.type}`).toEqual({
        ok: false,
        from: machine.state,
        event: event.type
      })
      expect(next.machine).toBe(machine)
    }
  })
})

describe('the tab band (07 §24 I-22)', () => {
  it('[S23.01, ADR-025] the band holds every tab beside the island, on the screen side, from its anchored end', () => {
    // A 200 × 52 island on the bottom edge, anchored at its right end: the tabs rise above it (side top), each aligned
    // to its chamber's right end, so a long name runs toward the island's start and past it.
    const island = { width: 200, height: 52 }
    const bottom = { edge: 'bottom', end: 'end' } as const
    expect(
      tabBand(bottom, island, [
        { x: -110, y: -40, width: 290, height: 44 },
        { x: 40, y: -40, width: 158, height: 44 }
      ])
    ).toEqual({ width: 310, height: 40 })
    // Anchored at the left end, a tab runs past the island's far end.
    expect(
      tabBand({ edge: 'bottom', end: 'start' }, island, [{ x: 2, y: -40, width: 290, height: 44 }])
    ).toEqual({ width: 292, height: 40 })
    // A top edge: the tabs hang below it.
    expect(
      tabBand({ edge: 'top', end: 'start' }, island, [{ x: 2, y: 48, width: 150, height: 44 }])
    ).toEqual({ width: 200, height: 40 })
    // A right edge: the island is a column, the tabs rise to its left, aligned to the chamber's bottom end.
    expect(
      tabBand({ edge: 'right', end: 'end' }, { width: 52, height: 300 }, [
        { x: -270, y: 150, width: 274, height: 44 }
      ])
    ).toEqual({ width: 270, height: 300 })
    // A left edge: they rise to its right.
    expect(
      tabBand({ edge: 'left', end: 'start' }, { width: 52, height: 300 }, [
        { x: 48, y: 2, width: 274, height: 44 }
      ])
    ).toEqual({ width: 270, height: 300 })
    // No tab laid out (no chamber, or nothing measured yet): no band.
    expect(tabBand(bottom, island, [])).toBeNull()
    expect(tabBand(bottom, island, [{ x: 0, y: 0, width: 0, height: 0 }])).toBeNull()
  })
})
