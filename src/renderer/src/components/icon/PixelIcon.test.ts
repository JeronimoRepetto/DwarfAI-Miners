// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { ICON_GRIDS } from '../../lib/icon/iconGrids'
import { iconRuns } from '../../lib/icon/iconRegistry'
import PixelIcon from './PixelIcon.vue'

describe('PixelIcon', () => {
  it('is decorative: the control holding it carries the name', () => {
    expect(mount(PixelIcon, { props: { name: 'close' } }).attributes('aria-hidden')).toBe('true')
  })

  it('shows at 1x by default and at 2x when asked, never between', () => {
    expect(mount(PixelIcon, { props: { name: 'close' } }).classes()).toEqual([
      'dm-icon',
      'dm-icon--x1'
    ])
    expect(mount(PixelIcon, { props: { name: 'close', scale: 2 } }).classes()).toContain(
      'dm-icon--x2'
    )
  })

  it('adds its tone class', () => {
    const icon = mount(PixelIcon, { props: { name: 'close', tone: 'danger' } })
    expect(icon.classes()).toContain('dm-icon--danger')
  })

  it('draws its grid as a crisp 16x16 svg, one rect per run, each classed by its key', () => {
    const svg = mount(PixelIcon, { props: { name: 'send' } }).find('svg')
    expect(svg.attributes('viewBox')).toBe('0 0 16 16')
    expect(svg.attributes('shape-rendering')).toBe('crispEdges')
    const rects = svg.findAll('rect')
    const runs = iconRuns(ICON_GRIDS.send)
    expect(rects).toHaveLength(runs.length)
    expect(rects[0]!.attributes()).toMatchObject({
      x: String(runs[0]!.x),
      y: String(runs[0]!.y),
      width: String(runs[0]!.width),
      height: '1',
      class: runs[0]!.className
    })
  })
})
