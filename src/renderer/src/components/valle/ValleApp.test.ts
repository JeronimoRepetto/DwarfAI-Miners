// @vitest-environment jsdom
import type { MoveToModeParams, UiPreferenceWrite } from '@dwarfai/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import { VALLE_STORE_DEFAULTS, type ValleStores } from '../../composables/useValleStores'
import { defaultValleLayouts } from '../../lib/valle/preset'
import {
  BORIN,
  DAIN,
  EREBOR,
  KHAZAD,
  MORIA,
  dwarfWire,
  mineWire,
  snapshotPage
} from '../../lib/veta/testing/vetaFixtures'
import ValleApp from './ValleApp.vue'
import { valleBridgeOf } from './valleEntry'

/*
 * The Valle root wired to its preset (ISSUE-300; 07 machine 28, S29.02, S32.02; UC-053, UC-069) over the generated fake
 * `window.api`: the inputs reach machine 28, each change is written through A-N21, and the restored pins and mosaic
 * order are drawn once the Host's facts are read.
 */

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let root: VueWrapper | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.innerHTML = ''
})

function mountValle(stores: Partial<ValleStores>) {
  const writes: UiPreferenceWrite[] = []
  const moves: MoveToModeParams[] = []
  const api = createFakeWindowApi({
    getHostSnapshot: () =>
      Promise.resolve(
        snapshotPage(10, {
          minesEverKnown: true,
          mines: [mineWire(MORIA), mineWire(EREBOR)],
          dwarfs: [dwarfWire(BORIN, MORIA)]
        })
      ) as never,
    setUiPreference: (write) => {
      writes.push(write as UiPreferenceWrite)
      return Promise.resolve(write) as never
    },
    moveToMode: (params) => {
      moves.push(params as MoveToModeParams)
      return Promise.resolve({ ok: true }) as never
    }
  })
  root = mount(ValleApp, {
    attachTo: document.body,
    props: {
      bridge: valleBridgeOf(api),
      stores: { ...VALLE_STORE_DEFAULTS, ...stores },
      observer: () => new InertObserver()
    }
  })
  return { root, writes, moves }
}

const esc = (): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

describe('the Valle root and its presets (ISSUE-300)', () => {
  it('[S28.19, S28.20, US-VALLE-001.AC02] Esc leaves a nav page first, then the Work front, the top bar and the chat zone staying in place', async () => {
    const { root, writes } = mountValle({ preset: 'front' })
    await flushPromises()
    const valle = root.get('[data-valle-root]')
    const bar = root.get('header.dm-vbar').element
    const chats = root.get('aside[aria-label="Pinned chats"]').element

    await root.get('[data-slot="map"]').trigger('click')
    expect(valle.attributes('data-page')).toBe('map')
    expect(root.find('[data-valle-page="map"]').exists()).toBe(true)
    esc()
    await flushPromises()
    expect(valle.attributes('data-page')).toBe('mines')
    expect(valle.attributes('data-preset')).toBe('front')
    esc()
    await flushPromises()
    expect(valle.attributes('data-preset')).toBe('control')
    // The top bar and the chat zone are the same elements throughout (VA3).
    expect(root.get('header.dm-vbar').element).toBe(bar)
    expect(root.get('aside[aria-label="Pinned chats"]').element).toBe(chats)
    expect(writes).toEqual([{ key: 'vallePreset', value: 'control' }])
  })

  it("[US-VALLE-001.AC04, US-VALLE-001.AC07, S28.16, S28.17] the Work front's list folds to the MINES strip and back, each change written through A-N21", async () => {
    const { root, writes } = mountValle({ preset: 'front' })
    await flushPromises()
    await root.get('button[aria-label="Fold the list"]').trigger('click')
    const strip = root.get('button[aria-label="Show the mines list"]')
    expect(strip.text()).toBe('MINES')
    expect(root.get('.dm-valle__main').attributes('style')).toContain('--list-w: 44px')
    await strip.trigger('click')
    expect(root.get('.dm-valle__main').attributes('style')).toContain('--list-w: 232px')
    const folded = defaultValleLayouts()
    folded.front.foldedList = true
    expect(writes).toEqual([
      { key: 'valleLayout', value: folded },
      { key: 'valleLayout', value: defaultValleLayouts() }
    ])
  })

  it("[US-VALLE-001.AC09, S29.02, S32.02] the restored pins and mosaic order are drawn once the Host's facts are read, a dwarf ended meanwhile gone", async () => {
    const { root } = mountValle({
      preset: 'control',
      pins: [
        { dwarfId: DAIN, mineId: EREBOR, order: 1 },
        { dwarfId: BORIN, mineId: MORIA, order: 0 }
      ],
      mosaicOrder: [EREBOR, KHAZAD, MORIA]
    })
    await flushPromises()
    expect(
      root
        .findAll('[data-pin]')
        .map((pin) => [pin.attributes('data-pin'), pin.attributes('data-pin-state')])
    ).toEqual([
      [BORIN, 'live'],
      [DAIN, 'gone']
    ])
    expect(
      root.findAll('[data-valle-column]').map((c) => c.attributes('data-valle-column'))
    ).toEqual([EREBOR, MORIA])
  })
})

// APPENDED for ISSUE-302: the pinned chats in the Valle root (07 machine 29; TC-302-01).
describe('the pinned chats in the Valle root (ISSUE-302)', () => {
  // TC-302-01: every pin action is persisted at once, chat pins only.
  it('[S29.02, S29.10] the restored pins are the Control room’s stack and the Work front’s tabs, and an unpin is written through A-N21 at once', async () => {
    const { root, writes } = mountValle({
      preset: 'control',
      pins: [
        { dwarfId: BORIN, mineId: MORIA, order: 0 },
        { dwarfId: DAIN, mineId: EREBOR, order: 1 }
      ]
    })
    await flushPromises()
    const chats = root.get('aside[aria-label="Pinned chats"]')
    expect(chats.find('section.dm-cstack').exists()).toBe(true)
    expect(chats.get('.dm-cstack__count').text()).toBe('2')
    expect(chats.get('[data-expanded="true"]').attributes('data-pin')).toBe(BORIN)

    await root.get('[data-preset-tab="front"]').trigger('click')
    expect(chats.find('section.dm-cstack').exists()).toBe(false)
    expect(chats.findAll('[role="tab"]').map((tab) => tab.attributes('data-pin'))).toEqual([
      BORIN,
      DAIN
    ])
    await chats.get(`[role="tab"][data-pin="${DAIN}"] .dm-ctab__x`).trigger('click')
    expect(chats.findAll('[role="tab"]').map((tab) => tab.attributes('data-pin'))).toEqual([BORIN])
    expect(writes.filter((write) => write.key === 'pins')).toEqual([
      { key: 'pins', value: [{ dwarfId: BORIN, mineId: MORIA, order: 0 }] }
    ])
  })
})
