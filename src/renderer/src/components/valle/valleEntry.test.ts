// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import { VALLE_STORE_DEFAULTS } from '../../composables/useValleStores'
import {
  BORIN,
  MORIA,
  dwarfWire,
  mineWire,
  snapshotPage
} from '../../lib/veta/testing/vetaFixtures'
import ValleApp from './ValleApp.vue'
import { isValleRoot, valleBridgeOf } from './valleEntry'

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('the Valle entry of the renderer (ADR-025 item 1; 05 §2.3; ISSUE-299)', () => {
  it('[ADR-025] the page loaded with ?mode=valle mounts the Valle root, no other page does', () => {
    expect(isValleRoot('?mode=valle')).toBe(true)
    expect(isValleRoot('')).toBe(false)
    expect(isValleRoot('?mode=veta')).toBe(false)
    expect(isValleRoot('?mode=VALLE')).toBe(false)
  })

  it('[S39.03, ADR-024] the Valle root first paints with the stores it was read with, and draws no copy of its own', async () => {
    const api = createFakeWindowApi({
      getHostSnapshot: () =>
        Promise.resolve(
          snapshotPage(10, {
            minesEverKnown: true,
            mines: [mineWire(MORIA)],
            dwarfs: [dwarfWire(BORIN, MORIA)]
          })
        ) as never
    })
    const root = mount(ValleApp, {
      props: {
        bridge: valleBridgeOf(api),
        stores: { ...VALLE_STORE_DEFAULTS, preset: 'front' },
        observer: (callback: unknown, options: unknown) => {
          void callback
          void options
          return new InertObserver()
        }
      }
    })
    const valle = root.find('[data-valle-root]')
    expect(valle.exists()).toBe(true)
    expect(valle.attributes('data-preset')).toBe('front')
    await flushPromises()
    expect(valle.attributes('data-held')).toBe('false')
    expect(root.text()).toBe('')
    root.unmount()
  })
})
