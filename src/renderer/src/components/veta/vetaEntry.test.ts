// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import VetaApp from './VetaApp.vue'
import { windowRoot } from './vetaEntry'

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
    const root = mount(VetaApp)
    expect(root.find('[data-veta-root]').exists()).toBe(true)
    // No user-visible text: Veta's copy arrives with its strip.
    expect(root.text()).toBe('')
  })
})
