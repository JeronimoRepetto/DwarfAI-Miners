// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BORIN,
  DAIN,
  EREBOR,
  MORIA,
  dwarfWire,
  mineWire,
  type VetaSnapshotData
} from '../../lib/veta/testing/vetaFixtures'
import AddPanel from '../launch/AddPanel.vue'
import DwarfMessagePanel from '../message/DwarfMessagePanel.vue'
import { mountVeta, shownRisen, type VetaWorld } from './testing/mountVeta'

/*
 * ISSUE-290 (TC-290-03, TC-290-04; 07 machine 24; UC-048, UC-066; BR-21; ADR-025 item 2): the window risen above the
 * Veta strip inside the Veta root, over the generated fake `window.api`. It hosts the Panel's own MessagePanel and Add
 * panel; UI main grows the window before it rises and shrinks it after it folds.
 */

const TWO_MINES: VetaSnapshotData = {
  minesEverKnown: true,
  mines: [mineWire(MORIA), mineWire(EREBOR, { tier: 'gold' })],
  dwarfs: [
    dwarfWire(BORIN, MORIA, { status: 'working' }),
    dwarfWire(DAIN, EREBOR, { status: 'asleep' })
  ]
}

let world: VetaWorld | undefined
afterEach(() => {
  world?.unmount()
  world = undefined
  document.body.innerHTML = ''
})

const dwarf = (dwarfId: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-veta-dwarf][data-dwarf-id="${dwarfId}"]`)!

describe('the window risen above the Veta strip', () => {
  it("[US-VETA-005.AC07, BR-21] the risen chat is the Panel's MessagePanel with the same features, only its anchor differs", async () => {
    world = await mountVeta(TWO_MINES, {
      session: { drafts: { [BORIN]: 'half a thought' }, chatViews: {} } as never
    })
    dwarf(BORIN).click()
    await flushPromises()

    expect(world.root.find('[data-veta-risen]').exists()).toBe(true)
    const card = world.root.get('[data-veta-risen]')
    expect(card.attributes('data-content')).toBe('chat')
    expect(shownRisen()).toBe('shown')
    // The Panel's own component, on the board's dwarf, its draft given back from the session store.
    const panel = world.root.getComponent(DwarfMessagePanel)
    expect(card.element.contains(panel.element)).toBe(true)
    expect(panel.props('dwarf')).toMatchObject({ id: BORIN })
    expect(panel.props('draft')).toBe('half a thought')
    // Its features are the Panel's: the header's tools, the conversation log and the composer, as the Panel draws them.
    expect(panel.element.matches('section.dm-msg[role="dialog"]')).toBe(true)
    expect(panel.find('.dm-msg__log[role="log"]').exists()).toBe(true)
    expect(panel.find('textarea').exists()).toBe(true)
    expect(panel.findAll('header button').length).toBeGreaterThan(1)
    // Only its anchor differs: the card around it is placed above the strip, with its pointer at the dwarf.
    expect(card.find('.veta-risen__ptr').exists()).toBe(true)
    expect(card.attributes('style')).toMatch(/bottom: 66px/)
    expect(card.attributes('style')).toMatch(/--ptr: \d+px/)
    // The session store knows the open chat in Veta.
    expect(world.patches).toEqual(
      expect.arrayContaining([
        { kind: 'veta-risen-chat', dwarfId: BORIN },
        { kind: 'open-chat', host: 'veta', dwarfId: BORIN }
      ])
    )
    // The chamber draws the open dwarf pressed.
    expect(dwarf(BORIN).getAttribute('aria-pressed')).toBe('true')

    // Esc folds it with its draft kept in the session store.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(shownRisen()).toBe('none')
    expect(world.patches).toEqual(
      expect.arrayContaining([
        { kind: 'draft', dwarfId: BORIN, text: 'half a thought' },
        { kind: 'veta-risen-chat', dwarfId: null }
      ])
    )

    // The Add panel is the Panel's own too, aimed at the mine whose "+" asked for it.
    const chamber = document.querySelector<HTMLElement>(
      `[data-veta-chamber][data-mine-id="${EREBOR}"]`
    )!
    chamber.dispatchEvent(new PointerEvent('pointerenter'))
    await flushPromises()
    chamber.querySelector<HTMLButtonElement>('[data-tab-add]')!.click()
    await flushPromises()
    expect(world.root.get('[data-veta-risen]').attributes('data-content')).toBe('add')
    expect(world.root.getComponent(AddPanel).props('mineName')).toBe('erebor')
    expect(world.root.get('[data-veta-root]').attributes('data-add-panel-for')).toBe(EREBOR)
  })

  it('[ADR-025] layoutVeta rise is answered before the rise starts and layoutVeta fold is sent after the fold ends', async () => {
    world = await mountVeta(TWO_MINES, { holdRises: true })
    dwarf(BORIN).click()
    await flushPromises()
    // Asked, not answered: nothing has risen in a window too small for it.
    expect(world.layouts.at(-1)).toMatchObject({ kind: 'rise', dwarfId: BORIN })
    expect(world.risenAtLayout).toEqual(['rise:none'])
    expect(shownRisen()).not.toBe('shown')
    expect(world.patches).toEqual([])
    await world.answerRises()
    expect(shownRisen()).toBe('shown')

    // A press outside it in the window (the strip's chamber here) folds it; the window shrinks only once it is gone.
    document
      .querySelector<HTMLElement>(`[data-veta-chamber][data-mine-id="${EREBOR}"]`)!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(world.layouts.at(-1)).toEqual({ kind: 'fold' })
    expect(world.risenAtLayout).toEqual(['rise:none', 'fold:hidden'])
    const folds = world.layouts.filter((r) => r.kind === 'fold')
    expect(folds).toHaveLength(1)
  })

  it('[US-VETA-005.AC03, S24.08] a draft typed in the risen chat is kept in the session store when it folds', async () => {
    world = await mountVeta(TWO_MINES)
    dwarf(BORIN).click()
    await flushPromises()
    await world.root.get('[data-veta-risen] textarea').setValue('typed in Veta')
    expect(world.patches).toContainEqual({ kind: 'draft', dwarfId: BORIN, text: 'typed in Veta' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    // The fold keeps what was typed, never an empty draft over it.
    const drafts = world.patches.filter((patch) => patch.kind === 'draft')
    expect(drafts.at(-1)).toEqual({ kind: 'draft', dwarfId: BORIN, text: 'typed in Veta' })
  })
})
