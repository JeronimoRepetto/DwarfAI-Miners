import type { MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import {
  CLOSED_GRIP_MENU,
  gripMenuEntries,
  stepGripMenu,
  type GripMenu,
  type GripMenuContext,
  type GripMenuEvent,
  type GripMenuStep
} from './gripMenu'
import { pickerRows } from './minePicker'
import { EREBOR, KHAZAD, MORIA, mineWire } from './testing/vetaFixtures'

/*
 * ISSUE-288 (TC-288-01, TC-288-03, TC-288-04): 07 machine 22, the grip menu and the mine picker, pure. Each step is
 * named by its 07 id; a step 07 does not list is rejected and the state is held. The unit tests run with a
 * built-modes list that includes Valle (the E2E profile's), as the issue asks; the release list is checked apart.
 */

const WITH_VALLE: GripMenuContext = { liveMines: 2, built: ['panel', 'veta', 'valle'] }
const NO_MINES: GripMenuContext = { liveMines: 0, built: ['panel', 'veta', 'valle'] }

/** Runs events from a machine, collecting each step. */
function run(
  events: readonly GripMenuEvent[],
  context: GripMenuContext = WITH_VALLE,
  from: GripMenu = CLOSED_GRIP_MENU
): { machine: GripMenu; steps: GripMenuStep[] } {
  let machine = from
  const steps: GripMenuStep[] = []
  for (const event of events) {
    const next = stepGripMenu(machine, event, context)
    machine = next.machine
    steps.push(next.step)
  }
  return { machine, steps }
}

const ids = (steps: readonly GripMenuStep[]): Array<string | null> =>
  steps.map((step) => (step.ok ? step.id : null))

const labels = (built: GripMenuContext['built']): string[] =>
  gripMenuEntries(built).map((entry) => (entry.kind === 'rule' ? '—' : entry.label))

const PICKED = '01920000-0000-7000-8000-00000000a009' as MineId

describe('machine 22 diagram conformance', () => {
  it('[US-VETA-003.AC01, S22.01, S22.02] a left click, a right click, Enter or Space on the grip opens the identical menu', () => {
    const click = run([{ type: 'grip-click', dragging: false }])
    // A right-click, Enter and Space all reach the grip as one "open" (S22.02).
    const open = run([{ type: 'grip-open' }])
    expect(ids(click.steps)).toEqual(['S22.01'])
    expect(ids(open.steps)).toEqual(['S22.02'])
    expect(click.machine.state).toBe('menu-open')
    expect(open.machine).toEqual(click.machine)
    expect(click.machine.opener).toBe('grip')
    // A press that became a drag opens nothing (S22.01 guard, no drag).
    expect(run([{ type: 'grip-click', dragging: true }]).machine.state).toBe('closed')
  })

  it('[US-VETA-003.AC02] the menu lists Open Panel, Open Valle, New dwarf in…, a rule and Hide window, in that order, and never Mute sounds', () => {
    expect(labels(WITH_VALLE.built)).toEqual([
      'Open Panel',
      'Open Valle',
      'New dwarf in…',
      '—',
      'Hide window'
    ])
    const entries = gripMenuEntries(WITH_VALLE.built)
    expect(entries.find((e) => e.kind === 'item' && e.id === 'new-dwarf')).toMatchObject({
      hint: '▸'
    })
    expect(labels(WITH_VALLE.built).some((label) => /mute/i.test(label))).toBe(false)
  })

  it('[BR-19, ADR-034] with Valle not built the menu lists three items and no Open Valle', () => {
    expect(labels(['panel'])).toEqual(['Open Panel', 'New dwarf in…', '—', 'Hide window'])
    expect(labels(['panel', 'veta'])).toEqual(['Open Panel', 'New dwarf in…', '—', 'Hide window'])
    // Hidden until built: Open Valle cannot be chosen either (S22.05 guard).
    const { machine, steps } = run(
      [{ type: 'grip-open' }, { type: 'choose', item: 'open-valle' }],
      {
        liveMines: 2,
        built: ['panel', 'veta']
      }
    )
    expect(steps[1]?.ok).toBe(false)
    expect(machine.state).toBe('menu-open')
  })

  it('[US-VETA-003.AC03, US-VETA-011.AC02, S22.04] Open Panel moves to the Panel with no mine implied', () => {
    const { machine, steps } = run([{ type: 'grip-open' }, { type: 'choose', item: 'open-panel' }])
    expect(ids(steps)).toEqual(['S22.02', 'S22.04'])
    expect(machine.state).toBe('closed')
    expect(steps[1]).toMatchObject({ effects: [{ kind: 'move', mode: 'panel' }] })
    expect(steps[1]?.ok === true && steps[1].effects[0]).not.toHaveProperty('mineId')
  })

  it('[US-VETA-003.AC04, S22.05] Open Valle moves to Valle', () => {
    const { machine, steps } = run([{ type: 'grip-open' }, { type: 'choose', item: 'open-valle' }])
    expect(ids(steps)).toEqual(['S22.02', 'S22.05'])
    expect(machine.state).toBe('closed')
    expect(steps[1]).toMatchObject({ effects: [{ kind: 'move', mode: 'valle' }] })
  })

  it('[US-VETA-003.AC05, S22.07] New dwarf in… opens the picker listing every live mine, those without a chamber included', () => {
    const { machine, steps } = run([{ type: 'grip-open' }, { type: 'choose', item: 'new-dwarf' }])
    expect(ids(steps)).toEqual(['S22.02', 'S22.07'])
    expect(machine.state).toBe('picker-open')
    // Nobody works in erebor or khazad, so neither has a chamber; the picker lists them all the same.
    const rows = pickerRows([
      { mine: mineWire(MORIA), crew: 2 },
      { mine: mineWire(EREBOR), crew: 0 },
      { mine: mineWire(KHAZAD), crew: 0 }
    ])
    expect(rows.map((row) => row.mineId).sort()).toEqual([MORIA, EREBOR, KHAZAD].sort())
  })

  it('[US-VETA-003.AC06, S22.06] Hide window moves to hidden', () => {
    const { machine, steps } = run([{ type: 'grip-open' }, { type: 'choose', item: 'hide' }])
    expect(ids(steps)).toEqual(['S22.02', 'S22.06'])
    expect(machine.state).toBe('closed')
    expect(steps[1]).toMatchObject({ effects: [{ kind: 'move', mode: 'hidden' }] })
  })

  it('[US-VETA-003.AC07, S22.03] an outside click or Esc closes the menu with no other effect and focus returns to the grip', () => {
    const { machine, steps } = run([{ type: 'grip-click', dragging: false }, { type: 'dismiss' }])
    expect(ids(steps)).toEqual(['S22.01', 'S22.03'])
    expect(machine.state).toBe('closed')
    // Nothing moves, nothing is added: the one effect is the focus back on the grip.
    expect(steps[1]).toMatchObject({ effects: [{ kind: 'focus', target: 'grip' }] })
  })

  it('[S22.08, S22.10, S22.11, S22.12, S22.13, S22.14, S22.15, S22.16, S22.17, S22.18] the picker, folder and declare transitions follow 07 machine 22', () => {
    // S22.08: the first-run entrance "+", and "New dwarf in…" with no live mine, open the empty picker.
    const entrance = run([{ type: 'entrance' }], NO_MINES)
    expect(ids(entrance.steps)).toEqual(['S22.08'])
    expect(entrance.machine).toMatchObject({ state: 'picker-empty', opener: 'entrance' })
    const noMine = run([{ type: 'grip-open' }, { type: 'choose', item: 'new-dwarf' }], NO_MINES)
    expect(ids(noMine.steps)).toEqual(['S22.02', 'S22.08'])
    expect(noMine.machine).toMatchObject({ state: 'picker-empty', opener: 'grip' })

    // S22.18: typing and arrows stay in the picker. S22.09: an enterable mine picked raises the Add panel at it.
    const pick = run([
      { type: 'grip-open' },
      { type: 'choose', item: 'new-dwarf' },
      { type: 'filter' },
      { type: 'pick-mine', mineId: PICKED, enterable: true }
    ])
    expect(ids(pick.steps)).toEqual(['S22.02', 'S22.07', 'S22.18', 'S22.09'])
    expect(pick.machine.state).toBe('closed')
    expect(pick.steps[3]).toMatchObject({ effects: [{ kind: 'add-panel', mineId: PICKED }] })

    // S22.10 → S22.11: the folder dialog cancelled goes back to the picker it came from, adding nothing.
    const cancelled = run([
      { type: 'grip-open' },
      { type: 'choose', item: 'new-dwarf' },
      { type: 'add-mine' },
      { type: 'folder-cancelled' }
    ])
    expect(ids(cancelled.steps)).toEqual(['S22.02', 'S22.07', 'S22.10', 'S22.11'])
    expect(cancelled.steps[2]).toMatchObject({ effects: [{ kind: 'pick-folder' }] })
    expect(cancelled.steps[3]).toMatchObject({ effects: [] })
    expect(cancelled.machine.state).toBe('picker-open')
    const cancelledEmpty = run(
      [{ type: 'entrance' }, { type: 'add-mine' }, { type: 'folder-cancelled' }],
      NO_MINES
    )
    expect(cancelledEmpty.machine.state).toBe('picker-empty')

    // S22.12 → S22.13: a new mine hands off to the Panel on it; the Add panel does not open.
    const added = run(
      [
        { type: 'entrance' },
        { type: 'add-mine' },
        { type: 'folder-picked' },
        { type: 'declared', mineId: PICKED, worktree: false }
      ],
      NO_MINES
    )
    expect(ids(added.steps)).toEqual(['S22.08', 'S22.10', 'S22.12', 'S22.13'])
    expect(added.steps[3]).toMatchObject({
      effects: [{ kind: 'move', mode: 'panel', mineId: PICKED }]
    })
    expect(added.machine.state).toBe('closed')

    // S22.14: a worktree folds into its main project's mine, then the same hand-off.
    const worktree = run([
      { type: 'grip-open' },
      { type: 'choose', item: 'new-dwarf' },
      { type: 'add-mine' },
      { type: 'folder-picked' },
      { type: 'declared', mineId: PICKED, worktree: true }
    ])
    expect(ids(worktree.steps).at(-1)).toBe('S22.14')
    expect(worktree.steps.at(-1)).toMatchObject({
      effects: [{ kind: 'move', mode: 'panel', mineId: PICKED }]
    })

    // S22.15: a refused declare, or a Host out of reach, goes back to the picker it came from; nothing added.
    const refused = run([
      { type: 'grip-open' },
      { type: 'choose', item: 'new-dwarf' },
      { type: 'add-mine' },
      { type: 'folder-picked' },
      { type: 'declare-failed' }
    ])
    expect(ids(refused.steps).at(-1)).toBe('S22.15')
    expect(refused.machine.state).toBe('picker-open')
    const refusedEmpty = run(
      [
        { type: 'entrance' },
        { type: 'add-mine' },
        { type: 'folder-picked' },
        { type: 'declare-failed' }
      ],
      NO_MINES
    )
    expect(refusedEmpty.machine.state).toBe('picker-empty')

    // S22.16: Esc or an outside click closes the picker; focus goes back to whatever opened it.
    const fromGrip = run([
      { type: 'grip-open' },
      { type: 'choose', item: 'new-dwarf' },
      { type: 'dismiss' }
    ])
    expect(ids(fromGrip.steps).at(-1)).toBe('S22.16')
    expect(fromGrip.steps.at(-1)).toMatchObject({ effects: [{ kind: 'focus', target: 'grip' }] })
    const fromEntrance = run([{ type: 'entrance' }, { type: 'dismiss' }], NO_MINES)
    expect(fromEntrance.steps.at(-1)).toMatchObject({
      ok: true,
      id: 'S22.16',
      effects: [{ kind: 'focus', target: 'entrance' }]
    })

    // S22.17: a drag, a mode change or the window hidden closes the menu or the picker silently.
    for (const open of [
      [{ type: 'grip-open' }],
      [{ type: 'grip-open' }, { type: 'choose', item: 'new-dwarf' }],
      [{ type: 'entrance' }]
    ] as GripMenuEvent[][]) {
      const interrupted = run([...open, { type: 'interrupt' }])
      expect(interrupted.steps.at(-1)).toMatchObject({ ok: true, id: 'S22.17', effects: [] })
      expect(interrupted.machine.state).toBe('closed')
    }
  })

  it('[ADR-025] a transition not listed in 07 machine 22 is rejected', () => {
    const cases: Array<[events: GripMenuEvent[], rejected: GripMenuEvent]> = [
      // A grip click with the menu open, a mine picked from the menu, a cancel with no dialog open.
      [[{ type: 'grip-open' }], { type: 'grip-click', dragging: false }],
      [[{ type: 'grip-open' }], { type: 'pick-mine', mineId: PICKED, enterable: true }],
      [[], { type: 'folder-cancelled' }],
      [[], { type: 'dismiss' }],
      // I-39: an unenterable mine is never picked.
      [
        [{ type: 'grip-open' }, { type: 'choose', item: 'new-dwarf' }],
        { type: 'pick-mine', mineId: PICKED, enterable: false }
      ],
      // The dialog and the declare are in flight: Esc, an outside click or an interruption change nothing.
      [
        [{ type: 'grip-open' }, { type: 'choose', item: 'new-dwarf' }, { type: 'add-mine' }],
        { type: 'dismiss' }
      ],
      [
        [
          { type: 'grip-open' },
          { type: 'choose', item: 'new-dwarf' },
          { type: 'add-mine' },
          { type: 'folder-picked' }
        ],
        { type: 'interrupt' }
      ],
      // "New dwarf in…" from the empty picker is not a menu item there.
      [[{ type: 'entrance' }], { type: 'choose', item: 'open-panel' }]
    ]
    for (const [events, rejected] of cases) {
      const before = run(events).machine
      const { machine, step } = stepGripMenu(before, rejected, WITH_VALLE)
      expect(step, JSON.stringify(rejected)).toMatchObject({ ok: false, from: before.state })
      expect(machine).toEqual(before)
    }
    // S22.19: a cue playing with the menu open is no transition: there is no mute item to reach.
    const open = run([{ type: 'grip-open' }]).machine
    const cue = stepGripMenu(open, { type: 'cue' }, WITH_VALLE)
    expect(cue.step).toMatchObject({
      ok: true,
      id: 'S22.19',
      from: 'menu-open',
      to: 'menu-open',
      effects: []
    })
    expect(cue.machine).toEqual(open)
  })
})
