// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EdgeRail from './EdgeRail.vue'

function mountRail(props: { edge?: 'left' | 'right'; expanded?: boolean } = {}) {
  return mount(EdgeRail, {
    props: { edge: 'right' as const, expanded: false, ...props }
  })
}

describe('EdgeRail', () => {
  it('is one real button, so the whole rail opens the panel', () => {
    // The design says selecting the RAIL expands the panel, not selecting a
    // hit area somewhere inside a 20px strip.
    const rail = mountRail()
    expect(rail.element.tagName).toBe('BUTTON')
    expect(rail.attributes('type')).toBe('button')
  })

  it('carries the state on the control rather than only in its name', () => {
    expect(mountRail().attributes('aria-expanded')).toBe('false')
    expect(mountRail({ expanded: true }).attributes('aria-expanded')).toBe('true')
  })

  it('says what pressing it will do, in both states', () => {
    expect(mountRail().attributes('aria-label')).toMatch(/open/i)
    expect(mountRail({ expanded: true }).attributes('aria-label')).toMatch(/collapse/i)
  })

  it('asks to be toggled, and decides nothing itself', () => {
    // The window is main's: the rail reports the press and renders whatever
    // layout comes back, so a refused resize can never leave it drawn open.
    const rail = mountRail()
    rail.trigger('click')
    expect(rail.emitted('toggle')).toHaveLength(1)
    expect(rail.attributes('aria-expanded')).toBe('false')
  })

  it('points the arrow inward while closed, and back at its edge while open', () => {
    expect(mountRail({ edge: 'right' }).find('.rail-arrow').classes()).toContain('points-left')
    expect(mountRail({ edge: 'left' }).find('.rail-arrow').classes()).toContain('points-right')
    expect(mountRail({ edge: 'right', expanded: true }).find('.rail-arrow').classes()).toContain(
      'points-right'
    )
    expect(mountRail({ edge: 'left', expanded: true }).find('.rail-arrow').classes()).toContain(
      'points-left'
    )
  })

  it('shows the app mark on the closed rail and hands it over once open', () => {
    // Expanded, the mark belongs at the top of the navigation column — drawing
    // it twice would put two of them on one edge.
    expect(mountRail().find('.rail-mark').exists()).toBe(true)
    expect(mountRail({ expanded: true }).find('.rail-mark').exists()).toBe(false)
  })

  it('paints the rail surface only while it IS the rail', () => {
    expect(mountRail().classes()).toContain('is-closed')
    expect(mountRail({ expanded: true }).classes()).not.toContain('is-closed')
  })

  it('reports which edge it hangs on, so the frame can mirror with it', () => {
    expect(mountRail({ edge: 'left' }).classes()).toContain('edge-left')
    expect(mountRail({ edge: 'right' }).classes()).toContain('edge-right')
  })
})
