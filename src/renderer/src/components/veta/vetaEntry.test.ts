// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import type { VetaLayoutRequest } from '@dwarfai/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import {
  BORIN,
  MORIA,
  dwarfWire,
  mineWire,
  snapshotPage
} from '../../lib/veta/testing/vetaFixtures'
import VetaApp from './VetaApp.vue'
import { windowRoot } from './vetaEntry'

// The Veta root reads its dock through `window.api` (ISSUE-286): every member inert unless a case answers it.
const installApi = (overrides: Parameters<typeof createFakeWindowApi>[0] = {}) => {
  ;(window as unknown as { api: unknown }).api = createFakeWindowApi(overrides)
}
afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('the Veta entry of the renderer (ADR-025 item 1; 05 §2.3)', () => {
  it('[ADR-025] the page loaded with ?mode=veta mounts the Veta root, any other page the Panel', () => {
    expect(windowRoot('?mode=veta')).toBe('veta')
    expect(windowRoot('')).toBe('panel')
    expect(windowRoot('?mode=panel')).toBe('panel')
    // An unknown or repeated mode is not Veta: only the window UI main built for Veta asks for it.
    expect(windowRoot('?mode=valle')).toBe('panel')
    expect(windowRoot('?mode=VETA')).toBe('panel')
  })

  it('[ADR-025] the Veta root draws an empty, transparent strip until the strip arrives (ISSUE-287)', () => {
    installApi()
    const root = mount(VetaApp)
    expect(root.find('[data-veta-root]').exists()).toBe(true)
    // No user-visible text: Veta's copy arrives with its strip.
    expect(root.text()).toBe('')
  })

  it('[US-VETA-002.AC04, S21.11] the grip carries the design label, and an arrow key on it docks to that edge', async () => {
    const requests: VetaLayoutRequest[] = []
    let edge: 'left' | 'right' | 'top' | 'bottom' = 'bottom'
    installApi({
      // AMENDED for ISSUE-287: the grip is drawn with the chambers only (the closed entrance is then the island's one
      // part, DS/docs/components.md Veta strip), so the Host answers with a dwarf at work.
      getHostSnapshot: () =>
        Promise.resolve(
          snapshotPage(1, {
            minesEverKnown: true,
            mines: [mineWire(MORIA)],
            dwarfs: [dwarfWire(BORIN, MORIA, { status: 'working' })]
          })
        ) as never,
      layoutVeta: (request) => {
        requests.push(request as VetaLayoutRequest)
        // AMENDED for ISSUE-287 (was: every other kind answered the bottom edge): UI main answers the place it holds,
        // so a resize after the dock-key answers the edge the island was docked to.
        if (request.kind === 'dock-key') edge = request.edge
        return Promise.resolve({
          applied: true,
          displayKey: 'Q27G2WG4|2560x1440|@1|0,0',
          dock: { edge, end: 'end', offset: 16 }
        })
      }
    })
    const root = mount(VetaApp)
    await flushPromises()
    const grip = root.get('[data-veta-grip]')
    expect(grip.attributes('aria-label')).toBe(
      'Veta. Press for the menu; drag, or use the arrow keys, to move it to another edge'
    )
    expect(grip.attributes('title')).toBe('Drag to move · click for the menu')
    await grip.trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    // AMENDED for ISSUE-287 (was: the dock-key was the last request): on a side edge the chamber is a shaft, longer
    // than the row it was (42k + 18 against 40k + 18 px), so the island's new length re-places it right after.
    expect(requests.slice(-2)).toEqual([
      { kind: 'dock-key', edge: 'right' },
      { kind: 'island-resize', length: 4 + 36 + 36 + 60 }
    ])
    // On a side edge the island turns vertical (US-VETA-002.AC08).
    expect(root.get('[data-veta-island]').classes()).toContain('is-vertical')
    expect(root.get('[data-veta-root]').attributes('data-edge')).toBe('right')
  })
})
