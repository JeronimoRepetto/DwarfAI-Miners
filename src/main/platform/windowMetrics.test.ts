import { describe, expect, it } from 'vitest'
import type { Platform } from './platform'
import { RAIL_WIDTH } from '../shell/panelBounds'
import { minWindowWidth } from './windowMetrics'

describe('minWindowWidth', () => {
  it('keeps the measured Windows floor, which is wider than the rail it carries (#153)', () => {
    // 32 is a measurement, not a guess: a BrowserWindow asked for 20px comes
    // back 32px wide on Windows, and asking for the floor is what makes a
    // left-docked rail the same window as a right-docked one.
    expect(minWindowWidth('win32')).toBe(32)
    expect(minWindowWidth('win32')).toBeGreaterThan(RAIL_WIDTH)
  })

  it.each<Platform>(['darwin', 'linux'])(
    'asks %s for the design’s own rail, because no floor was ever measured there (#465)',
    (platform) => {
      // The pin that keeps the deliberate copy in windowMetrics.ts equal to the
      // rail panelBounds.ts derives every other width from: a floor WIDER than
      // the painted rail is what leaves the transparent gutter macOS then draws
      // its shadow around.
      expect(minWindowWidth(platform)).toBe(RAIL_WIDTH)
    }
  )

  it('answers every supported platform with a whole number of pixels', () => {
    // Electron bounds take nothing else, and this number reaches them as a
    // window width through panelBounds.ts.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(Number.isInteger(minWindowWidth(platform))).toBe(true)
      expect(minWindowWidth(platform)).toBeGreaterThan(0)
    }
  })
})
