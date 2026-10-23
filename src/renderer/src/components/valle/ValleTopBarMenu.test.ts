// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import { VALLE_STORE_DEFAULTS, type ValleStores } from '../../composables/useValleStores'
import {
  BORIN,
  EREBOR,
  MORIA,
  dwarfWire,
  mineWire,
  snapshotPage
} from '../../lib/veta/testing/vetaFixtures'
import { createFakeAudioPlayer } from '../../lib/audio/fakeAudioPlayer'
import ValleApp from './ValleApp.vue'
import ValleTopBarMenu from './ValleTopBarMenu.vue'
import { valleBridgeOf } from './valleEntry'

/*
 * Valle's top bar "⋯" menu (ISSUE-309; 07 machine 37; US-VALLE-010; NFR-A11Y-02): one action, "Reset preset", not offered
 * while a dive or a climb plays, closed by Esc or an outside press; and the toast it raises goes through the one toast
 * contract (BR-23).
 */

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})

const mountMenu = (props: { open: boolean; offered: boolean }) => {
  wrapper = mount(ValleTopBarMenu, { attachTo: document.body, props })
  return wrapper
}

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** The Valle root over the generated fake `window.api`, a Control room of two mines with one crew. */
function mountValle(stores: Partial<ValleStores>) {
  const hostListeners: ((frames: unknown) => void)[] = []
  const api = createFakeWindowApi({
    onHostEvent: (listener) => {
      hostListeners.push(listener as (frames: unknown) => void)
      return () => {}
    },
    queryProjects: () => Promise.resolve({ answered: true, projects: [] }) as never,
    getHostSnapshot: () =>
      Promise.resolve(
        snapshotPage(10, {
          minesEverKnown: true,
          mines: [mineWire(MORIA), mineWire(EREBOR)],
          dwarfs: [dwarfWire(BORIN, MORIA)]
        })
      ) as never,
    setUiPreference: (write) => Promise.resolve(write) as never
  })
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: api })
  wrapper = mount(ValleApp, {
    attachTo: document.body,
    props: {
      bridge: valleBridgeOf(api),
      stores: { ...VALLE_STORE_DEFAULTS, ...stores },
      observer: () => new InertObserver(),
      bodyObserver: () => () => {},
      audioPlayer: createFakeAudioPlayer()
    }
  })
  return wrapper
}

describe('the Valle top bar menu (ISSUE-309)', () => {
  it('[US-VALLE-010.AC01, S37.01] the "⋯" opens a menu holding Reset preset alone, and picking it asks for the reset', async () => {
    const menu = mountMenu({ open: false, offered: true })
    const more = menu.get('button[aria-label="Preset options"]')
    expect(more.attributes('title')).toBe('Preset options')
    expect(more.attributes('aria-haspopup')).toBe('menu')
    expect(more.attributes('aria-expanded')).toBe('false')
    expect(menu.find('[role="menu"]').exists()).toBe(false)

    await more.trigger('click')
    expect(menu.emitted('toggle')).toHaveLength(1)

    await menu.setProps({ open: true })
    expect(more.attributes('aria-expanded')).toBe('true')
    const items = menu.findAll('[role="menuitem"]')
    expect(items.map((item) => item.text())).toEqual(['Reset preset'])
    await items[0]!.trigger('click')
    expect(menu.emitted('reset')).toHaveLength(1)
  })

  it('[S37.01] Reset preset is not offered while a dive or a climb plays', async () => {
    const menu = mountMenu({ open: false, offered: false })
    const more = menu.get('button[aria-label="Preset options"]')
    expect(more.attributes('disabled')).toBeDefined()
    await more.trigger('click')
    expect(menu.emitted('toggle')).toBeUndefined()
  })

  it('[S37.02, NFR-A11Y-02] Esc and a press outside close the menu and nothing else, the focus coming back to the "⋯"', async () => {
    const menu = mountMenu({ open: true, offered: true })
    await flushPromises()
    // The focus goes to the first item when the menu opens.
    expect(document.activeElement?.textContent).toContain('Reset preset')

    await menu.get('[role="menu"]').trigger('keydown', { key: 'Escape' })
    expect(menu.emitted('dismiss')).toHaveLength(1)
    await menu.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(menu.get('button[aria-label="Preset options"]').element)

    await menu.setProps({ open: true })
    await flushPromises()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(menu.emitted('dismiss')).toHaveLength(2)
    // A press on the "⋯" itself is its own toggle, not an outside press.
    menu
      .get('button[aria-label="Preset options"]')
      .element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(menu.emitted('dismiss')).toHaveLength(2)
    expect(menu.emitted('reset')).toBeUndefined()
  })

  it('[US-VALLE-010.AC05, BR-23] the reset toast follows the general toast rule and covers none of the mines, the chats or a composer', async () => {
    const root = mountValle({ preset: 'control', mosaicOrder: [MORIA, EREBOR] })
    await flushPromises()
    await root.get('[data-preset-more]').trigger('click')
    await root.get('[role="menuitem"]').trigger('click')
    await flushPromises()

    // The one toast contract: the window's one host, standing over the main zone alone (07 §24 I-38: the design has no
    // Valle rule yet), outside the nav, the chat zone and the mines.
    const hosts = root.findAll('.dm-toasts')
    expect(hosts).toHaveLength(1)
    // Only the toast this reset adds is counted: the window's queue is a module singleton.
    const added = hosts[0]!
      .findAll(':scope > *')
      .filter((toast) => toast.text().includes('Control room is back to its preset'))
    expect(added).toHaveLength(1)
    const host = hosts[0]!.element
    const area = root.get('[data-valle-toasts]').element
    expect(host.parentElement).toBe(area)
    expect(area.closest('nav, aside')).toBeNull()
    // Nothing the toast could cover contains it, and it contains none of them: the mines, the chats, a composer.
    const covered = [
      ...root.element.querySelectorAll(
        '[data-valle-column], [data-valle-zone], aside[aria-label="Pinned chats"], .dm-composer'
      )
    ]
    expect(covered.length).toBeGreaterThan(0)
    for (const element of covered) {
      expect(element.contains(host), 'the host is outside it').toBe(false)
      expect(host.contains(element), 'it is outside the host').toBe(false)
    }
  })
})
