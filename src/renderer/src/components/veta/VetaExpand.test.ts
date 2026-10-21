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
import { mountVeta, VETA_PLACE, type VetaWorld } from './testing/mountVeta'

/*
 * ISSUE-293 (US-VETA-011; 07 S10.05, S21.19; UC-051 "Expand ▲ or grip Open Panel"): Veta's "▲" and the grip menu's
 * "Open Panel" are two routes to one action, the Panel with no mine implied, over the generated fake `window.api`. The
 * keyboard presses on "▲" itself (Tab, then Enter or Space on the native button) run in `e2e/veta/handoff.e2e.ts`:
 * jsdom does not activate a button from a key.
 */

const TWO_MINES: VetaSnapshotData = {
  minesEverKnown: true,
  mines: [mineWire(MORIA), mineWire(EREBOR)],
  dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)]
}

let world: VetaWorld | undefined
afterEach(() => {
  world?.unmount()
  world = undefined
  document.body.innerHTML = ''
})

/** Opens the grip menu and picks "Open Panel". */
async function openPanelFromGrip(veta: VetaWorld): Promise<void> {
  await veta.root.get('[data-veta-grip]').trigger('contextmenu')
  await flushPromises()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (el) => el.textContent?.trim() === 'Open Panel'
  )
  expect(item, 'the grip menu offers Open Panel').toBeDefined()
  item!.click()
  await flushPromises()
}

describe('Veta expand and the grip menu Open Panel (ISSUE-293)', () => {
  it("[US-VETA-011.AC01, US-VETA-011.AC02, S10.05] ▲ by click, or by Tab and Enter or Space, and the grip's Open Panel both move to the Panel with no mine implied", async () => {
    world = await mountVeta(TWO_MINES)
    const expand = world.root.get<HTMLButtonElement>('[data-veta-expand]')
    // A native button in the tab order: Tab reaches it, Enter and Space press it.
    expect(expand.element.tagName).toBe('BUTTON')
    expect(expand.element.type).toBe('button')
    expect(expand.element.tabIndex).toBeGreaterThanOrEqual(0)
    expect(expand.element.disabled).toBe(false)
    expect(expand.attributes('aria-label')).toBe('Open the Panel')

    await expand.trigger('click')
    await flushPromises()
    await openPanelFromGrip(world)
    // The same move both ways, naming no mine and no dwarf.
    expect(world.moves).toEqual([{ mode: 'panel' }, { mode: 'panel' }])

    // With a chat risen, ▲ still implies no mine: the chat is not handed off by it.
    document.querySelector<HTMLElement>(`[data-veta-dwarf][data-dwarf-id="${BORIN}"]`)!.click()
    await flushPromises()
    world.root.get('[data-veta-expand]').element.dispatchEvent(new MouseEvent('click'))
    await flushPromises()
    expect(world.moves.at(-1)).toEqual({ mode: 'panel' })
  })

  it('[US-VETA-011.AC03, S21.19] when ▲ runs off a short edge the grip stays reachable and Open Panel still reaches the Panel', async () => {
    // A left edge anchored at its end: ▲ is the anchor end, the one that runs off a short edge; the grip is the other.
    world = await mountVeta(TWO_MINES, {
      place: { ...VETA_PLACE, dock: { edge: 'left', end: 'end', offset: 16 } }
    })
    const island = world.root.get('[data-veta-island]').element
    const parts = [...island.querySelectorAll<HTMLElement>('[data-veta-part]')].map(
      (el) => el.dataset['vetaPart']
    )
    expect(parts.at(-1)).toBe('expand')
    expect(parts[0]).toBe('grip')
    // The grip end stays on screen: the grip takes the keyboard and opens its menu.
    const grip = world.root.get<HTMLElement>('[data-veta-grip]')
    expect(grip.element.tabIndex).toBeGreaterThanOrEqual(0)
    await openPanelFromGrip(world)
    expect(world.moves).toEqual([{ mode: 'panel' }])
  })
})
