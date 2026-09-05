import { describe, expect, it } from 'vitest'
import type { Platform } from './platform'
import { panelScreenArea, type DisplayAreas } from './screenArea'

/**
 * A display with a reserved strip along the bottom — a Windows taskbar, or the
 * macOS Dock — so the two rectangles differ and a test can tell which one the
 * rule picked.
 */
const DISPLAY: DisplayAreas = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 }
}

/**
 * A display reserved on BOTH edges the way a real Mac is: a slim menu-bar
 * strip along the top and the Dock along the bottom, so `workArea` moves both
 * `y` and `height` relative to `bounds` rather than just `height` the way the
 * Windows taskbar fixture above does. A fix that only special-cased height
 * would still fail this one.
 */
const TOP_AND_BOTTOM_RESERVED: DisplayAreas = {
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 25, width: 2560, height: 1291 }
}

/**
 * A display reserved on the LEFT edge — a Dock (or a taskbar) docked to the
 * side rather than the bottom, so `workArea.x` moves inward while `bounds.x`
 * stays at the display's own origin.
 */
const LEFT_DOCKED: DisplayAreas = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 70, y: 0, width: 1850, height: 1080 }
}

describe('panelScreenArea', () => {
  it('leaves the Windows taskbar visible', () => {
    expect(panelScreenArea(DISPLAY, 'win32')).toEqual(DISPLAY.workArea)
  })

  it.each<Platform>(['darwin', 'linux'])(
    'leaves the reserved strip visible on %s too, not just Windows (#238)',
    (platform) => {
      // Until #238 this asserted the OPPOSITE: that macOS and Linux got the
      // whole display, following what the design's source said twice. That
      // was never checked on a real Mac — the Dock sits exactly in the strip
      // `workArea` reserves, and a real Mac showed the panel's own bottom
      // controls (Add panel, Message panel) landing behind it. `workArea` is
      // the right default on every platform, not a Windows-only carve-out.
      expect(panelScreenArea(DISPLAY, platform)).toEqual(DISPLAY.workArea)
    }
  )

  it.each<Platform>(['darwin', 'linux'])(
    'reserves a top-and-bottom strip on %s the same way a real Mac does (#238)',
    (platform) => {
      expect(panelScreenArea(TOP_AND_BOTTOM_RESERVED, platform)).toEqual(
        TOP_AND_BOTTOM_RESERVED.workArea
      )
    }
  )

  it.each<Platform>(['darwin', 'linux'])(
    'reserves a left-docked strip on %s too, not just a bottom one',
    (platform) => {
      expect(panelScreenArea(LEFT_DOCKED, platform)).toEqual(LEFT_DOCKED.workArea)
    }
  )

  it('carries the display origin through, so a secondary monitor still works', () => {
    const secondary: DisplayAreas = {
      bounds: { x: -1920, y: 120, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 120, width: 1920, height: 1032 }
    }
    expect(panelScreenArea(secondary, 'win32').x).toBe(-1920)
    expect(panelScreenArea(secondary, 'darwin').y).toBe(120)
  })

  it('returns the rectangle unchanged when nothing is reserved', () => {
    const full: DisplayAreas = {
      bounds: { x: 0, y: 0, width: 1366, height: 768 },
      workArea: { x: 0, y: 0, width: 1366, height: 768 }
    }
    expect(panelScreenArea(full, 'win32')).toEqual(full.bounds)
  })
})
