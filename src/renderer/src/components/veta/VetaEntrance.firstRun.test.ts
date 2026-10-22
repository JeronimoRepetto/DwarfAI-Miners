// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { frame, MORIA, mineWire, type VetaSnapshotData } from '../../lib/veta/testing/vetaFixtures'
import { mountVeta, shownOverlay, shownRisen, type VetaWorld } from './testing/mountVeta'

/*
 * ISSUE-295 (TC-295-01, TC-295-02): Veta's first run, from the closed entrance (07 machine 20 S20.01, S20.05, S20.13;
 * machine 22 S22.08, S22.16; US-VETA-010). The entrance is mounted inside the Veta root, which decides what its
 * activation does, over the generated fake `window.api` with fixture snapshots and frames. The entrance's motion cases
 * live in `VetaEntrance.test.ts`.
 */

const FIRST_RUN: VetaSnapshotData = { minesEverKnown: false, mines: [], dwarfs: [] }

let world: VetaWorld | undefined
afterEach(() => {
  world?.unmount()
  world = undefined
  document.body.innerHTML = ''
})

const entrance = (): HTMLElement => document.querySelector<HTMLElement>('[data-veta-entrance]')!
const picker = (): HTMLElement | null => document.querySelector('[data-mine-picker]')

/** Opens the empty picker the way a person does on first run: a click on the entrance "+". */
async function clickPlus(veta: VetaWorld): Promise<void> {
  await veta.root.get('[data-veta-entrance]').trigger('click')
  await flushPromises()
}

describe('the Veta entrance on first run (ISSUE-295)', () => {
  it('[US-VETA-010.AC01, S20.01] with no mine ever known the entrance carries + instead of the bare lantern', async () => {
    world = await mountVeta(FIRST_RUN)
    expect(entrance().dataset.first).toBe('true')
    expect(entrance().querySelector('[data-veta-plus]')).not.toBeNull()
    expect(entrance().getAttribute('aria-label')).toBe('No mines yet. Add your first mine')
    expect(entrance().getAttribute('title')).toBe('Add your first mine')
  })

  it('[US-VETA-010.AC02, S20.13, S22.08] clicking + opens the empty picker with Add a mine as its only action, never the Add panel', async () => {
    world = await mountVeta(FIRST_RUN)
    await clickPlus(world)
    expect(shownOverlay()).toBe('picker')
    const dialog = picker()!
    expect(dialog.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(dialog.querySelector('.dm-picker__none')?.textContent).toBe(
      'No mines yet. Add a project folder to start.'
    )
    const actions = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([hidden])')]
    expect(actions.map((b) => b.textContent?.trim())).toEqual(['Add a mine'])
    // Never the Add panel, never a move, never the folder picker before "Add a mine".
    expect(world.root.get('[data-veta-root]').attributes('data-add-panel-for')).toBeUndefined()
    expect(shownRisen()).not.toBe('shown')
    expect([world.moves, world.declares]).toEqual([[], []])
  })

  it('[US-VETA-010.AC05, S20.05] once any mine exists the entrance is the ordinary one, even with no dwarf active', async () => {
    // A mine on the board counts as ever known, whatever `minesEverKnown` says (ISSUE-082 has not set it yet).
    world = await mountVeta({ minesEverKnown: false, mines: [mineWire(MORIA)], dwarfs: [] })
    expect(entrance().dataset.first).toBe('false')
    expect(entrance().querySelector('[data-veta-plus]')).toBeNull()
    expect(entrance().getAttribute('aria-label')).toBe('No sessions running. Open the Panel')
    world.unmount()

    // From first run, the first mine created leaves the "+" for good.
    world = await mountVeta(FIRST_RUN)
    expect(entrance().dataset.first).toBe('true')
    await world.push([frame(11, 'mine.changed', { mine: mineWire(MORIA) } as never)])
    expect(entrance().dataset.first).toBe('false')
    expect(entrance().querySelector('[data-veta-plus]')).toBeNull()
    // Its activation is the ordinary one: the Panel with no mine.
    await world.root.get('[data-veta-entrance]').trigger('click')
    await flushPromises()
    expect(world.moves).toEqual([{ mode: 'panel' }])
    expect(shownOverlay()).toBe('none')
  })

  it('[US-VETA-010.AC06, S22.16, NFR-A11Y-02] Esc or an outside click on the empty picker adds nothing, returns focus to + and stays on first run', async () => {
    world = await mountVeta(FIRST_RUN)
    await clickPlus(world)
    expect(shownOverlay()).toBe('picker')
    picker()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(shownOverlay()).toBe('none')
    expect(document.activeElement).toBe(entrance())
    expect(entrance().dataset.first).toBe('true')

    await clickPlus(world)
    expect(shownOverlay()).toBe('picker')
    // A press on the window outside the picker (here, on the island) closes it.
    const island = document.querySelector('[data-veta-island]')!
    island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await flushPromises()
    expect(shownOverlay()).toBe('none')
    expect(document.activeElement).toBe(entrance())
    expect(entrance().dataset.first).toBe('true')
    // Nothing was declared, moved or named for the Panel.
    expect([world.declares, world.moves, world.patches]).toEqual([[], [], []])
  })
})
