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

describe('panelScreenArea', () => {
  it('leaves the Windows taskbar visible', () => {
    expect(panelScreenArea(DISPLAY, 'win32')).toEqual(DISPLAY.workArea)
  })

  it.each<Platform>(['darwin', 'linux'])('spans the whole display on %s', (platform) => {
    // The design says the taskbar adjustment is unnecessary on macOS and Linux,
    // and says it twice. Following it is the point; second-guessing it here
    // would be inventing a rule the source declined to give.
    expect(panelScreenArea(DISPLAY, platform)).toEqual(DISPLAY.bounds)
  })

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
