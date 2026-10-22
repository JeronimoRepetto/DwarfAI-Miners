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

  it('[S39.03, ADR-024] the Valle root first paints with the stores it was read with, and draws only the copy of the parts built so far', async () => {
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
        },
        // jsdom has no ResizeObserver: the body is never measured, so the split stays off.
        bodyObserver: () => () => {}
      }
    })
    const valle = root.find('[data-valle-root]')
    expect(valle.exists()).toBe(true)
    expect(valle.attributes('data-preset')).toBe('front')
    await flushPromises()
    expect(valle.attributes('data-held')).toBe('false')
    // AMENDED for ISSUE-300 (was: no text at all): the top bar and the Work front's mines list are built, each with
    // the design's own copy (`organisms/valle-bar`, `organisms/mine-rows`); the zones' contents are not yet.
    // AMENDED for ISSUE-303: the Work front's deck carries "⫽" (`organisms/chat-deck`), disabled with no pin.
    // AMENDED for ISSUE-301: the compact list has a row per mine, reading the mine's own name (data, not copy).
    expect(root.text().replace(/\s+/g, ' ').trim()).toBe(
      'Control roomWork frontMODE ▼ Panel ▼ Veta Mines ⇤ moria⫽'
    )
    root.unmount()
  })
})
