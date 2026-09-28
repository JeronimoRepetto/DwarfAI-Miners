import { describe, expect, it } from 'vitest'
import type { Platform } from './platform'
import { minWindowWidth } from './windowMetrics'

/*
 * AMENDED for #635, once here: `RAIL_WIDTH` left `panelBounds.ts` with the rail (PO ruling
 * 2026-09-27), so the two cases below that compared a floor with it assert the numbers instead.
 */
describe('minWindowWidth', () => {
  it('keeps the measured Windows floor (#153)', () => {
    // 32 is a measurement, not a guess: a BrowserWindow asked for 20px comes
    // back 32px wide on Windows.
    expect(minWindowWidth('win32')).toBe(32)
  })

  it.each<Platform>(['darwin', 'linux'])(
    'asks %s for no more than the 20px it was always asked for, because no floor was ever measured there (#465)',
    (platform) => {
      // A floor wider than anything the window is asked to be is what leaves a
      // transparent gutter macOS then draws its shadow around (#465), and 20
      // is below every composition the Panel has.
      expect(minWindowWidth(platform)).toBe(20)
      expect(minWindowWidth(platform)).toBeLessThan(minWindowWidth('win32'))
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
