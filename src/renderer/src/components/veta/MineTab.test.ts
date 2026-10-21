// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
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
import MineTab from './MineTab.vue'
import { VETA_PLACE, mountVeta, shownOverlay, type VetaWorld } from './testing/mountVeta'

/*
 * ISSUE-289 (TC-289-01, TC-289-02; 07 machine 23; UC-047): a Veta chamber's mine tab (DS/docs/components.md, Mine tab
 * and Mine chamber; DS/docs/screens/veta.md V1b) alone and inside the Veta root, over the generated fake `window.api`.
 * Hover or keyboard focus raises one chamber's tab above it, never resizing the window, widening the strip or moving a
 * dwarf; "▢" moves to the Panel on that mine; "+" asks for the Add panel aimed at it; the chamber body does nothing.
 */

const TWO_MINES: VetaSnapshotData = {
  minesEverKnown: true,
  mines: [mineWire(MORIA), mineWire(EREBOR, { tier: 'gold' })],
  dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR, { status: 'working' })]
}

let world: VetaWorld | undefined
afterEach(() => {
  world?.unmount()
  world = undefined
  document.body.innerHTML = ''
})

const chamberOf = (mineId: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-veta-chamber][data-mine-id="${mineId}"]`)!

/** The mines whose tab is risen. */
const risen = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-veta-tab][data-risen="true"]')].map(
    (tab) => tab.closest<HTMLElement>('[data-veta-chamber]')!.dataset.mineId!
  )

const tabButton = (mineId: string, which: 'open' | 'add'): HTMLButtonElement =>
  chamberOf(mineId).querySelector<HTMLButtonElement>(`[data-tab-${which}]`)!

async function hover(mineId: string): Promise<void> {
  chamberOf(mineId).dispatchEvent(new PointerEvent('pointerenter'))
  await flushPromises()
}

describe('the Veta mine tab', () => {
  it('[US-VETA-004.AC02] a risen tab leaves the strip width and every dwarf position unchanged', async () => {
    world = await mountVeta(TWO_MINES)
    const asked = world.layouts.length
    const dwarfs = [...document.querySelectorAll('[data-veta-dwarf]')]
    const island = document.querySelector<HTMLElement>('[data-veta-island]')!
    /** The strip's parts in order, each with its inline style, and each chamber's crew. */
    const strip = (): string[] =>
      [...island.children].map(
        (part) =>
          `${(part as HTMLElement).dataset.vetaPart}${part.getAttribute('style') ?? ''}:` +
          [...part.querySelectorAll<HTMLElement>('[data-veta-dwarf]')]
            .map((d) => `${d.dataset.dwarfId}${d.getAttribute('style') ?? ''}`)
            .join(',')
      )
    const before = strip()
    expect(before).toHaveLength(4)
    expect(risen()).toEqual([])

    // Hover raises the tab over that chamber, and over that one only.
    await hover(MORIA)
    expect(risen()).toEqual([MORIA])
    // Keyboard focus raises it the same way, the pointer gone.
    chamberOf(MORIA).dispatchEvent(new PointerEvent('pointerleave'))
    chamberOf(EREBOR).focus()
    await flushPromises()
    expect(risen()).toEqual([EREBOR])

    // Nothing was asked of UI main: the window was not resized, nor the strip re-placed for a new length.
    expect(world.layouts.slice(asked)).toEqual([])
    // Every dwarf is the same element, in the same place in the strip, and the strip draws the same parts.
    expect([...document.querySelectorAll('[data-veta-dwarf]')]).toEqual(dwarfs)
    expect(strip()).toEqual(before)
  })

  it('[US-VETA-004.AC03, S23.04] Open moves to the Panel on that mine', async () => {
    world = await mountVeta(TWO_MINES)
    await hover(EREBOR)
    tabButton(EREBOR, 'open').click()
    await flushPromises()
    expect(world.moves).toEqual([{ mode: 'panel', mineId: EREBOR }])
    expect(risen()).toEqual([])
  })

  it('[US-VETA-004.AC04, S23.05] New dwarf asks for the Add panel aimed at this mine, with no picker', async () => {
    world = await mountVeta(TWO_MINES)
    await hover(MORIA)
    tabButton(MORIA, 'add').click()
    await flushPromises()
    // The Add panel's rise is ISSUE-290's (S24.03): the intent is the mine it is aimed at.
    expect(document.querySelector('[data-veta-root]')!.getAttribute('data-add-panel-for')).toBe(
      MORIA
    )
    expect(shownOverlay()).toBe('none')
    expect(document.querySelector('[data-mine-picker]')).toBeNull()
    expect(world.moves).toEqual([])
    expect(risen()).toEqual([])
  })

  it('[US-VETA-004.AC07, S23.06] a click on the chamber body does nothing', async () => {
    world = await mountVeta(TWO_MINES)
    const asked = world.layouts.length
    // Plain, then with its tab risen: the chamber is a container, never a target.
    chamberOf(MORIA).click()
    await hover(MORIA)
    chamberOf(MORIA).click()
    chamberOf(MORIA).querySelector<HTMLElement>('.veta-chamber__crew')!.click()
    await flushPromises()
    expect(world.moves).toEqual([])
    expect(world.layouts.slice(asked)).toEqual([])
    expect(document.querySelector('[data-veta-root]')!.hasAttribute('data-add-panel-for')).toBe(
      false
    )
    expect(shownOverlay()).toBe('none')
    expect(risen()).toEqual([MORIA])
  })

  it("[US-VETA-004.AC08] the tab shows the mine's tier chip and full name", async () => {
    const name = 'local-issue-classifier-with-a-long-name'
    const tab = mount(MineTab, {
      attachTo: document.body,
      props: { mine: mineWire(MORIA, { name, tier: 'gold' }) }
    })
    await flushPromises()
    const chip = tab.get('.dm-tier')
    expect(chip.attributes('data-tier')).toBe('gold')
    expect(chip.text()).toBe('Gold')
    expect(tab.get('[data-tab-name]').text()).toBe(name)
    // Both buttons carry the full name (DS/docs/accessibility.md, the Veta mine tab).
    expect(tab.get('[data-tab-open]').attributes('aria-label')).toBe(`Open ${name} in the Panel`)
    expect(tab.get('[data-tab-add]').attributes('aria-label')).toBe(`New dwarf in ${name}`)
    await tab.get('[data-tab-open]').trigger('click')
    await tab.get('[data-tab-add]').trigger('click')
    expect(Object.keys(tab.emitted())).toEqual(expect.arrayContaining(['open', 'add']))
    tab.unmount()
  })

  it("[NFR-A11Y-06] Tab reaches expand, each dwarf, each chamber's tab and the grip in that order", async () => {
    // Anchored at its start, the strip runs from the anchor outward: expand, the chambers, the grip.
    world = await mountVeta(TWO_MINES, {
      place: { ...VETA_PLACE, dock: { edge: 'bottom', end: 'start', offset: 16 } }
    })
    const island = document.querySelector<HTMLElement>('[data-veta-island]')!
    /** What Tab can reach now: focusable, and not inside a folded tab. */
    const tabbable = (): HTMLElement[] =>
      [...island.querySelectorAll<HTMLElement>('button, [tabindex]')].filter(
        (el) =>
          el.tabIndex >= 0 &&
          !(el as HTMLButtonElement).disabled &&
          el.closest('[aria-hidden="true"]') === null
      )
    const name = (el: HTMLElement): string => {
      const mine = el.closest<HTMLElement>('[data-veta-chamber]')?.dataset.mineId
      if (el.matches('[data-veta-chamber]')) return `chamber ${mine}`
      if (el.matches('[data-veta-dwarf]')) return `dwarf ${el.dataset.dwarfId}`
      if (el.matches('[data-tab-open]')) return `open ${mine}`
      if (el.matches('[data-tab-add]')) return `add ${mine}`
      return el.dataset.vetaPart ?? el.tagName
    }
    const walked: string[] = []
    let at: HTMLElement | undefined = tabbable()[0]
    while (at !== undefined) {
      at.focus()
      await flushPromises()
      walked.push(name(at))
      const now = tabbable()
      at = now[now.indexOf(at) + 1]
    }
    // A dwarf is not a target before ISSUE-290 makes it the button that opens its chat; each chamber is the stop that
    // raises its tab (the design's `.dm-chamber` holds tabindex 0), then the tab's two buttons.
    expect(walked).toEqual([
      'expand',
      `chamber ${MORIA}`,
      `open ${MORIA}`,
      `add ${MORIA}`,
      `chamber ${EREBOR}`,
      `open ${EREBOR}`,
      `add ${EREBOR}`,
      'grip'
    ])
    // Focus on a tab's button keeps that tab risen.
    tabButton(MORIA, 'add').focus()
    await flushPromises()
    expect(risen()).toEqual([MORIA])
  })
})
