// @vitest-environment jsdom
import type { MineId } from '@dwarfai/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { pickerRows } from '../../lib/veta/minePicker'
import {
  BORIN,
  EREBOR,
  KHAZAD,
  MORIA,
  dwarfWire,
  mineWire,
  type VetaSnapshotData
} from '../../lib/veta/testing/vetaFixtures'
import MinePicker from './MinePicker.vue'
import { mountVeta, shownOverlay, type VetaWorld } from './testing/mountVeta'

/*
 * ISSUE-288 (TC-288-02, TC-288-03, TC-288-04): the mine picker (US-LAUNCH-007; DS/docs/components.md, Mine picker),
 * alone and inside the Veta root, where the grip or the first-run entrance opens it over the generated fake
 * `window.api`. The keyboard is checked as a table (17 §1.12, L12).
 */

/** Moria has a crew; Erebor has nobody, so no chamber; Khazad cannot be entered. */
const MINES: VetaSnapshotData = {
  minesEverKnown: true,
  mines: [
    mineWire(MORIA, { lastUsedAt: 30 }),
    mineWire(EREBOR, { lastUsedAt: 20 }),
    mineWire(KHAZAD, { lastUsedAt: 10, state: 'unenterable' })
  ],
  dwarfs: [dwarfWire(BORIN, MORIA)]
}

const NEW_MINE = '01920000-0000-7000-8000-00000000a00b' as MineId

let world: VetaWorld | undefined
afterEach(() => {
  world?.unmount()
  world = undefined
  document.body.innerHTML = ''
})

/** Opens the picker the way a person does: Enter on the grip, then "New dwarf in…". */
async function openPicker(veta: VetaWorld): Promise<void> {
  await veta.root.get('[data-veta-grip]').trigger('keydown', { key: 'Enter' })
  await flushPromises()
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
    b.textContent?.includes('New dwarf in…')
  )
  item?.click()
  await flushPromises()
}

const picker = (): HTMLElement | null => document.querySelector('[data-mine-picker]')

function pickerAlone(rows = pickerRows(MINES.mines.map((mine) => ({ mine, crew: 0 })))) {
  return mount(MinePicker, { props: { rows, notice: null } })
}

describe('the mine picker', () => {
  it('[US-LAUNCH-007.AC01, US-LAUNCH-007.AC02] the picker opens focused in its search field, named Choose a mine, the field named and labelled Search mines', async () => {
    world = await mountVeta(MINES)
    await openPicker(world)
    expect(shownOverlay()).toBe('picker')
    const dialog = picker()!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('Choose a mine')
    const search = dialog.querySelector('input')!
    expect(search.getAttribute('placeholder')).toBe('Search mines')
    expect(search.getAttribute('aria-label')).toBe('Search mines')
    expect(document.activeElement).toBe(search)
  })

  it('[US-LAUNCH-007.AC05] an active search shows Clear search', async () => {
    const alone = pickerAlone()
    const clear = alone.get('button[aria-label="Clear search"]')
    expect(clear.attributes('hidden')).toBeDefined()
    await alone.get('input').setValue('mor')
    expect(clear.attributes('hidden')).toBeUndefined()
    expect(clear.attributes('title')).toBe('Clear search')
    expect(alone.findAll('[role="option"]').map((o) => o.attributes('data-mine'))).toEqual([MORIA])
    await clear.trigger('click')
    expect(alone.findAll('[role="option"]')).toHaveLength(3)
  })

  it('[US-LAUNCH-007.AC11, S22.09] a click or Enter on a row closes the picker and raises the Add panel aimed at that mine', async () => {
    world = await mountVeta(MINES)
    await openPicker(world)
    expect(shownOverlay()).toBe('picker')
    picker()!.querySelector<HTMLButtonElement>(`[data-mine="${EREBOR}"]`)!.click()
    await flushPromises()
    expect(shownOverlay()).toBe('none')
    expect(world.root.get('[data-veta-root]').attributes('data-add-panel-for')).toBe(EREBOR)

    await openPicker(world)
    const row = picker()!.querySelector<HTMLButtonElement>(`[data-mine="${MORIA}"]`)!
    row.focus()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(shownOverlay()).toBe('none')
    expect(world.root.get('[data-veta-root]').attributes('data-add-panel-for')).toBe(MORIA)
    // A pick neither moves the mode nor opens the folder picker.
    expect(world.moves).toEqual([])
    expect(world.declares).toEqual([])
  })

  it('[US-LAUNCH-007.AC12] Enter in the search field picks nothing', async () => {
    const alone = pickerAlone()
    // A disabled row is never picked, not even by Enter.
    await alone.get(`[data-mine="${KHAZAD}"]`).trigger('keydown', { key: 'Enter' })
    expect(alone.emitted('pick')).toBeUndefined()
    await alone.get('input').setValue('moria')
    await alone.get('input').trigger('keydown', { key: 'Enter' })
    expect(alone.emitted('pick')).toBeUndefined()
    expect(alone.emitted('add')).toBeUndefined()
    // Enter on a row is its click.
    await alone.get(`[data-mine="${MORIA}"]`).trigger('keydown', { key: 'Enter' })
    expect(alone.emitted('pick')).toEqual([[MORIA]])
  })

  it('[US-LAUNCH-007.AC14, S22.10, S22.13] Add a mine runs the folder flow and never opens the Add panel; a new mine hands off to the Panel on it', async () => {
    world = await mountVeta(MINES, { declare: { outcome: 'added', mineId: NEW_MINE } })
    await openPicker(world)
    expect(shownOverlay()).toBe('picker')
    picker()!.querySelector<HTMLButtonElement>('[data-picker-add]')!.click()
    await flushPromises()
    expect(world.declares).toEqual(['declareMine'])
    expect(world.moves).toEqual([{ mode: 'panel', mineId: NEW_MINE }])
    expect(world.root.get('[data-veta-root]').attributes('data-add-panel-for')).toBeUndefined()
    expect(shownOverlay()).toBe('none')
  })

  it('[US-LAUNCH-007.AC15, NFR-A11Y-02, S22.16] Esc or an outside click closes the picker and focus returns to its opener', async () => {
    world = await mountVeta(MINES)
    const grip = world.root.get('[data-veta-grip]').element as HTMLElement
    await openPicker(world)
    expect(shownOverlay()).toBe('picker')
    picker()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(shownOverlay()).toBe('none')
    expect(document.activeElement).toBe(grip)

    await openPicker(world)
    expect(shownOverlay()).toBe('picker')
    // A press on the window outside the picker (here, on the island) closes it.
    const island = document.querySelector('[data-veta-island]')!
    island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await flushPromises()
    expect(shownOverlay()).toBe('none')
    expect(document.activeElement).toBe(grip)
    // Nothing was added or moved.
    expect([world.moves, world.declares]).toEqual([[], []])
  })

  it('[US-LAUNCH-007.AC16, S22.08] with no mine the picker shows the empty text with Add a mine as its only option', async () => {
    world = await mountVeta({ minesEverKnown: false, mines: [], dwarfs: [] })
    await world.root.get('[data-veta-entrance]').trigger('click')
    await flushPromises()
    expect(shownOverlay()).toBe('picker')
    const dialog = picker()!
    expect(dialog.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(dialog.querySelector('.dm-picker__none')?.textContent).toBe(
      'No mines yet. Add a project folder to start.'
    )
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([hidden])')]
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Add a mine'])
    expect(document.activeElement).toBe(dialog.querySelector('input'))
    // ↓ from the search reaches Add a mine, and ↓ again wraps to the search.
    const keys: Array<[key: string, focused: string]> = [
      ['ArrowDown', 'add'],
      ['ArrowDown', 'search'],
      ['ArrowUp', 'add']
    ]
    for (const [key, focused] of keys) {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await flushPromises()
      const on = document.activeElement as HTMLElement
      expect(
        on.tagName === 'INPUT' ? 'search' : on.hasAttribute('data-picker-add') ? 'add' : '?',
        key
      ).toBe(focused)
    }
  })

  it('[US-MINES-004.AC03, US-MINES-004.AC07, ADR-025, S22.14] over Veta a worktree folder asks first, in a window grown for the question, and Cancel returns to the picker', async () => {
    world = await mountVeta(MINES, {
      declare: {
        outcome: 'worktree-of',
        worktreeOf: { worktree: 'C:/dev/alpha-worktrees/fix-ore', root: 'C:/dev/alpha' }
      },
      declareMain: { outcome: 'added', mineId: NEW_MINE },
      holdOverlays: true
    })
    await world.root.get('[data-veta-grip]').trigger('keydown', { key: 'Enter' })
    await world.answerOverlays()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.includes('New dwarf in…'))!
      .click()
    await flushPromises()
    await world.answerOverlays()
    expect(shownOverlay()).toBe('picker')
    const grown = world.layouts.filter((l) => l.kind === 'overlay').length
    picker()!.querySelector<HTMLButtonElement>('[data-picker-add]')!.click()
    await flushPromises()
    // The window is asked for the question's room first; the question shows only once it is answered.
    expect(world.layouts.filter((l) => l.kind === 'overlay').length).toBe(grown + 1)
    expect(
      document.querySelector('[role="dialog"][aria-label$="is a worktree of alpha"]')
    ).toBeNull()
    await world.answerOverlays()
    const question = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label$="is a worktree of alpha"]'
    )
    expect(question?.getAttribute('aria-label')).toBe('fix-ore is a worktree of alpha')
    expect(question?.textContent).toContain('Its dwarfs will work in alpha.')
    const actions = [...question!.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(actions).toEqual(['Cancel', 'Add alpha'])
    // Nothing is adopted or moved before the answer.
    expect([world.declares, world.moves]).toEqual([['declareMine'], []])

    // Cancel: nothing added, the picker again, and the room given back to the picker's size.
    question!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    await world.answerOverlays()
    expect(
      document.querySelector('[role="dialog"][aria-label$="is a worktree of alpha"]')
    ).toBeNull()
    expect(shownOverlay()).toBe('picker')
    expect(world.layouts.filter((l) => l.kind === 'overlay').length).toBe(grown + 2)
    expect([world.declares, world.moves]).toEqual([['declareMine'], []])

    // Add alpha: the main project is adopted and the Panel opens on it (US-MINES-004.AC06, S22.13).
    picker()!.querySelector<HTMLButtonElement>('[data-picker-add]')!.click()
    await flushPromises()
    await world.answerOverlays()
    const again = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label$="is a worktree of alpha"]'
    )!
    ;[...again.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Add alpha')!
      .click()
    await flushPromises()
    await world.answerOverlays()
    expect(world.declares).toEqual(['declareMine', 'declareMine', 'declareMainProject'])
    expect(world.moves).toEqual([{ mode: 'panel', mineId: NEW_MINE }])
    expect(shownOverlay()).toBe('none')
  })
})
