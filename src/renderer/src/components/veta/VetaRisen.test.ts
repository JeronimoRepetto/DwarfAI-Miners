// @vitest-environment jsdom
import type { DwarfId, MineId } from '@dwarfai/contracts'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BALIN,
  BELEGOST,
  BORIN,
  DAIN,
  DWALIN,
  EREBOR,
  FLOI,
  IRONHILLS,
  KHAZAD,
  MORIA,
  NALI,
  NOGROD,
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

  // APPENDED for ISSUE-292: a window resized under the pointer closes the "+N" list (ISSUE-291), as machine 26's own shrink.
  it('[S24.09, S25.06] the window shrinks after a chat fold only once the pointer has left the "+N" list it rests on', async () => {
    const six = [MORIA, EREBOR, KHAZAD, IRONHILLS, BELEGOST, NOGROD] as const
    const crew = [BORIN, DAIN, NALI, BALIN, DWALIN, FLOI] as const
    const folds: string[] = []
    let left = false
    world = await mountVeta(
      {
        minesEverKnown: true,
        mines: six.map((id) => mineWire(id)),
        dwarfs: six.map((id, i) => dwarfWire(crew[i]!, id))
      },
      {
        onLayout(request) {
          if (request.kind === 'fold') folds.push(left ? 'after the pointer left' : 'while hovered')
        }
      }
    )
    dwarf(BORIN).click()
    await flushPromises()
    expect(shownRisen()).toBe('shown')

    // The pointer rests on "+N", its list open; Esc folds the chat.
    const slot = document.querySelector<HTMLElement>('[data-veta-more-slot]')!
    slot.dispatchEvent(new PointerEvent('pointerenter'))
    await flushPromises()
    expect(shownList()).toBe('list')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(shownRisen()).toBe('none')
    // The room is not given back while the list is under the pointer.
    expect(folds).toEqual([])

    left = true
    slot.dispatchEvent(new PointerEvent('pointerleave'))
    await flushPromises()
    expect(folds).toEqual(['after the pointer left'])
    expect(shownList()).toBe('no list')
  })
})

// APPENDED for ISSUE-293: the chat hand-off between Veta and the Panel (07 S24.12, S24.18, machine 9; UC-051).
describe('the risen chat hand-off (ISSUE-293)', () => {
  it("[US-MSG-010.AC01, US-DLG-006.AC01, S24.12] Open in the Panel moves to the Panel with this dwarf's mine and chat and keeps the draft", async () => {
    world = await mountVeta(TWO_MINES, { runs: true })
    dwarf(BORIN).click()
    await flushPromises()
    const box = world.root.get('[data-veta-risen] textarea')
    await box.setValue('typed in Veta')
    ;(box.element as HTMLTextAreaElement).setSelectionRange(2, 7, 'backward')
    const before = world.patches.length

    const tool = world.root.find('[data-veta-risen] [data-open-in-panel]')
    expect(tool.exists()).toBe(true)
    await tool.trigger('click')
    await flushPromises()
    // One move, naming the chat's mine and dwarf: the Panel opens on them (S27.01).
    expect(world.moves).toEqual([{ mode: 'panel', mineId: MORIA, dwarfId: BORIN }])
    // The run's flush carries the draft and the caret to the session store before t0, for the Panel to show them.
    expect(world.patches.slice(before)).toEqual(
      expect.arrayContaining([
        { kind: 'draft', dwarfId: BORIN, text: 'typed in Veta' },
        {
          kind: 'chat-view',
          dwarfId: BORIN,
          view: { scrollAnchor: 'bottom', selection: { start: 2, end: 7, direction: 'backward' } }
        }
      ])
    )
  })

  it('[US-MSG-010.AC03] a chat risen from Veta labels its tool Open in the Panel', async () => {
    world = await mountVeta(TWO_MINES)
    dwarf(BORIN).click()
    await flushPromises()
    const tool = world.root.find('[data-veta-risen] .dm-msg__tools [data-open-in-panel]')
    expect(tool.exists()).toBe(true)
    expect(tool.attributes('title')).toBe('Open in the Panel')
    // The ▢ promote glyph, first among the header's tools.
    expect(tool.find('.dm-icon').exists()).toBe(true)
    expect(world.root.findAll('[data-veta-risen] .dm-msg__tools button')[0]!.element).toBe(
      tool.element
    )
  })

  it('[US-DLG-006.AC05, BR-21] dragging or resizing the anchored panel never moves the chat', async () => {
    world = await mountVeta(TWO_MINES)
    dwarf(BORIN).click()
    await flushPromises()
    const card = world.root.get('[data-veta-risen]')
    const placed = card.attributes('style')
    const layouts = world.layouts.length
    const head = card.get('.dm-msg__head').element
    // A press on the header dragged 200 px away and released, then a double-click: no drag, no move to another host.
    head.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 })
    )
    head.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 60 })
    )
    head.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 300, clientY: 60 }))
    head.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushPromises()
    expect(card.attributes('style')).toBe(placed)
    expect(world.layouts.slice(layouts)).toEqual([])
    expect(world.moves).toEqual([])
    expect(shownRisen()).toBe('shown')
    // Nothing offers to resize it: no handle, and the panel is not a resizable box.
    expect(card.find('[data-resize], .dm-resize').exists()).toBe(false)
    expect((card.element as HTMLElement).style.resize).toBe('')
  })

  it('[S24.12, S24.14] once Veta has played its half of the run to the Panel its risen chat folds at once, its draft kept', async () => {
    world = await mountVeta(TWO_MINES, { runs: true })
    dwarf(BORIN).click()
    await flushPromises()
    await world.root.get('[data-veta-risen] textarea').setValue('typed in Veta')
    await world.root.get('[data-veta-risen] [data-open-in-panel]').trigger('click')
    await flushPromises()
    // Under reduced motion the half lasts 0 ms: at t0 the window is veiled and the chat folds, with no motion.
    await new Promise((resolve) => setTimeout(resolve, 40))
    await flushPromises()
    expect(shownRisen()).toBe('none')
    expect(world.layouts.at(-1)).toEqual({ kind: 'fold' })
    expect(world.patches.filter((patch) => patch.kind === 'draft').at(-1)).toEqual({
      kind: 'draft',
      dwarfId: BORIN,
      text: 'typed in Veta'
    })
  })

  it('[S24.18] a run into Veta carrying a chat rises it once the window landed, with the draft from the session store', async () => {
    world = await mountVeta(TWO_MINES, {
      session: { drafts: { [BORIN]: 'carried from the Panel' }, chatViews: {} } as never
    })
    expect(shownRisen()).toBe('none')
    await world.transition({
      transitionId: 'run-in',
      from: 'panel',
      to: 'veta',
      t0: Date.now() + 16,
      role: 'target',
      chat: { dwarfId: BORIN as DwarfId, mineId: MORIA as MineId }
    })
    // Not before the shell motion: nothing has risen yet.
    expect(shownRisen()).toBe('none')
    // Under reduced motion the shell motion lasts 0 ms: the chat rises at t0.
    await new Promise((resolve) => setTimeout(resolve, 40))
    await flushPromises()
    expect(shownRisen()).toBe('shown')
    expect(world.root.getComponent(DwarfMessagePanel).props('draft')).toBe('carried from the Panel')
    expect(world.layouts.filter((r) => r.kind === 'rise').at(-1)).toMatchObject({
      kind: 'rise',
      dwarfId: BORIN
    })
  })
})

/** Whether the "+N" list shows. */
function shownList(): string {
  const list = document.querySelector<HTMLElement>('[data-veta-more-list]')
  return list?.dataset.shown === 'true' ? 'list' : 'no list'
}
