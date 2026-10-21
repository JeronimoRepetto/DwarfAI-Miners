// @vitest-environment jsdom
import type { DwarfWire } from '@dwarfai/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { dwarfLabels, labelBox, labelPlace, silenceOf } from '../../lib/veta/dwarfLabel'
import {
  BORIN,
  DAIN,
  MORIA,
  dwarfWire,
  mineWire,
  type VetaSnapshotData
} from '../../lib/veta/testing/vetaFixtures'
import DwarfLabel from './DwarfLabel.vue'
import VetaChamber from './VetaChamber.vue'
import { mountVeta, type VetaWorld } from './testing/mountVeta'

/*
 * ISSUE-290 (TC-290-01; 07 S24.19, S24.20; US-VETA-005.AC01, AC04, AC08; DS/docs/components.md, Mine chamber, Anatomy):
 * a dwarf in a Veta chamber is its own target at full sprite size. Hovering it shows its one-line label, centred on the
 * dwarf on every edge, and opens nothing; a press near it that misses it opens nothing either.
 */

let world: VetaWorld | undefined
afterEach(() => {
  world?.unmount()
  world = undefined
  document.body.innerHTML = ''
})

const ONE_MINE: VetaSnapshotData = {
  minesEverKnown: true,
  mines: [mineWire(MORIA)],
  dwarfs: [dwarfWire(BORIN, MORIA, { status: 'working' }), dwarfWire(DAIN, MORIA)]
}

function chamber(side: 'top' | 'bottom' | 'left' | 'right' = 'top') {
  const [borin, dain] = ONE_MINE.dwarfs as [DwarfWire, DwarfWire]
  return mount(VetaChamber, {
    attachTo: document.body,
    props: {
      mine: ONE_MINE.mines[0]!,
      dwarfs: [borin, dain],
      attention: false,
      vertical: side === 'left' || side === 'right',
      reverse: false,
      side,
      risen: false,
      openDwarf: null,
      labelsOf: (dwarf: DwarfWire) => dwarfLabels(dwarf, dwarf.id === BORIN ? 8_000 : undefined)
    }
  })
}

describe('a dwarf in a Veta chamber', () => {
  it('[US-VETA-005.AC01] hovering a dwarf shows name, status word and silence on one line and opens nothing', async () => {
    // The words: the design's, with the status words working, needs you, asleep and idle.
    const borin = dwarfWire(BORIN, MORIA, { status: 'working' })
    expect(dwarfLabels(borin, 8_000)).toEqual({
      tip: 'borin · working · silent 8s',
      aria: 'borin, working, silent 8s'
    })
    expect(
      dwarfLabels(dwarfWire(DAIN, MORIA, { status: 'asking', customName: 'Gimli' }), 180_000)
    ).toEqual({
      tip: 'Gimli · needs you · silent 3m',
      aria: 'Gimli, needs you, silent 3m'
    })
    // A silence nobody measured prints nothing rather than a guess.
    expect(dwarfLabels(dwarfWire(DAIN, MORIA, { status: 'asleep' }), undefined).tip).toBe(
      'dain · asleep'
    )
    expect(dwarfLabels(dwarfWire(DAIN, MORIA, { status: 'idle' }), undefined).tip).toBe(
      'dain · idle'
    )
    // The silence is the time since the dwarf's newest message.
    expect(
      silenceOf(
        [{ timestamp: '2026-10-21T10:00:00.000Z' }, { timestamp: '2026-10-21T10:00:30.000Z' }],
        Date.parse('2026-10-21T10:01:00.000Z')
      )
    ).toBe(30_000)
    expect(silenceOf([], 0)).toBeUndefined()
    expect(silenceOf(undefined, 0)).toBeUndefined()

    const wrapper = chamber()
    const dwarf = wrapper.get(`[data-veta-dwarf][data-dwarf-id="${BORIN}"]`)
    // Each dwarf is its own target, named for a screen reader as the design names it.
    expect(dwarf.element.tagName).toBe('BUTTON')
    expect(dwarf.attributes('aria-label')).toBe('borin, working, silent 8s')
    expect(wrapper.find('[data-veta-dwarf-label]').exists()).toBe(false)

    await dwarf.trigger('pointerenter')
    const label = wrapper.get('[data-veta-dwarf-label]')
    expect(label.text()).toBe('borin · working · silent 8s')
    // One line: plain text, no break.
    expect(label.element.querySelectorAll('br, p, div')).toHaveLength(0)
    expect(label.attributes('data-dwarf-id')).toBe(BORIN)
    // Nothing opens on a hover.
    expect(wrapper.emitted('dwarf')).toBeUndefined()

    await dwarf.trigger('pointerleave')
    expect(wrapper.find('[data-veta-dwarf-label]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('[US-VETA-005.AC04, S24.20] a click near a dwarf that misses it opens nothing', async () => {
    world = await mountVeta(ONE_MINE)
    const asked = world.layouts.length
    const body = document.querySelector<HTMLElement>(
      `[data-veta-chamber][data-mine-id="${MORIA}"]`
    )!
    // The chamber around the dwarfs, and its crew row between them: neither is a dwarf.
    for (const near of [body, body.querySelector<HTMLElement>('.veta-chamber__crew')!]) {
      near.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      near.click()
      await flushPromises()
    }
    expect(
      world.layouts.slice(asked).filter((r) => r.kind === 'rise' || r.kind === 'overlay')
    ).toEqual([])
    expect(document.querySelector('[data-veta-risen]')).toBeNull()
    // A hit on the sprite itself does open its chat.
    document.querySelector<HTMLElement>(`[data-veta-dwarf][data-dwarf-id="${BORIN}"]`)!.click()
    await flushPromises()
    expect(world.layouts.slice(asked).map((r) => r.kind)).toContain('rise')
  })

  it('[US-VETA-005.AC08, S24.19] the label centres on the dwarf on every edge, never on its chamber', async () => {
    // A row chamber: the dwarf's centre in the chamber, the label beyond the raised tab.
    const dwarf = { x: 60, y: 4, width: 36, height: 38 }
    expect(labelPlace('top', dwarf, null)).toEqual({ left: '78px', bottom: 'calc(100% + 46px)' })
    expect(labelPlace('bottom', dwarf, null)).toEqual({ left: '78px', top: 'calc(100% + 46px)' })
    // A shaft: the dwarf's centre down the chamber, beyond the tab where the dwarf is level with it.
    const shaftDwarf = { x: 4, y: 10, width: 36, height: 38 }
    const tab = { x: -120, y: -2, width: 120, height: 30 }
    expect(labelPlace('left', shaftDwarf, tab)).toEqual({
      top: '29px',
      right: 'calc(100% + 130px)'
    })
    expect(labelPlace('right', shaftDwarf, tab)).toEqual({
      top: '29px',
      left: 'calc(100% + 130px)'
    })
    const lower = { x: 4, y: 60, width: 36, height: 38 }
    expect(labelPlace('right', lower, tab)).toEqual({ top: '79px', left: 'calc(100% + 8px)' })

    // In the chamber: placed on the hovered dwarf, not on the chamber's centre.
    const wrapper = chamber('top')
    const target = wrapper.get(`[data-veta-dwarf][data-dwarf-id="${DAIN}"]`)
    const crew = wrapper.get('.veta-chamber__crew').element
    Object.defineProperty(crew, 'offsetLeft', { value: 10 })
    Object.defineProperty(crew, 'offsetTop', { value: 4 })
    Object.defineProperty(target.element, 'offsetLeft', { value: 40 })
    Object.defineProperty(target.element, 'offsetWidth', { value: 36 })
    Object.defineProperty(target.element, 'offsetHeight', { value: 38 })
    await target.trigger('pointerenter')
    const label = wrapper.getComponent(DwarfLabel)
    expect(label.props('side')).toBe('top')
    expect(label.attributes('style')).toContain('left: 68px')
    expect(label.attributes('style')).toContain('bottom: calc(100% + 46px)')
    expect(label.attributes('data-side')).toBe('top')
    wrapper.unmount()
  })

  it("[S24.19, ADR-025] the band holds the room of every dwarf's label, so a hover never resizes the window", async () => {
    // Where each label would stand, in the island's pixels: the same place `labelPlace` gives it, its size measured.
    const size = { width: 190, height: 20 }
    const chamber = { x: 40, y: 4, width: 100, height: 44 }
    const dwarf = { x: 60, y: 8, width: 36, height: 38 }
    expect(labelBox('top', chamber, dwarf, null, size)).toEqual({
      x: 78 - 95,
      y: 4 - 46 - 20,
      ...size
    })
    expect(labelBox('bottom', chamber, dwarf, null, size)).toEqual({
      x: 78 - 95,
      y: 48 + 46,
      ...size
    })
    const shaft = { x: 4, y: 40, width: 44, height: 120 }
    const tab = { x: 4 - 120, y: 38, width: 120, height: 30 }
    const level = { x: 8, y: 50, width: 36, height: 38 }
    expect(labelBox('left', shaft, level, tab, size)).toEqual({
      x: 4 - 130 - 190,
      y: 69 - 10,
      ...size
    })
    expect(labelBox('right', shaft, { ...level, y: 110 }, tab, size)).toEqual({
      x: 48 + 8,
      y: 129 - 10,
      ...size
    })

    // In the Veta root: hovering a dwarf asks UI main for nothing, the label's room is already held.
    world = await mountVeta(ONE_MINE)
    const asked = world.layouts.length
    document
      .querySelector<HTMLElement>(`[data-veta-dwarf][data-dwarf-id="${BORIN}"]`)!
      .dispatchEvent(new PointerEvent('pointerenter'))
    await flushPromises()
    expect(document.querySelector('[data-veta-dwarf-label]')).not.toBeNull()
    expect(world.layouts.slice(asked)).toEqual([])
  })
})
