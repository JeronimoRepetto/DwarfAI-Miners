// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import type { VetaLayoutRequest } from '@dwarfai/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
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
    installApi({
      layoutVeta: (request) => {
        requests.push(request as VetaLayoutRequest)
        const edge = request.kind === 'dock-key' ? request.edge : 'bottom'
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
    expect(requests.at(-1)).toEqual({ kind: 'dock-key', edge: 'right' })
    // On a side edge the island turns vertical (US-VETA-002.AC08).
    expect(root.get('[data-veta-island]').classes()).toContain('is-vertical')
    expect(root.get('[data-veta-root]').attributes('data-edge')).toBe('right')
  })
})
