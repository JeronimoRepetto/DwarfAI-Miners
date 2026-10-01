import { describe, expect, it } from 'vitest'
import type { ScreenAreaProvider } from './screenAreaProvider'

/**
 * The `ScreenAreaProvider` contract (16 §4.14, 16 §2.8), run by the double and by the real adapter alike: every display
 * it lists is answered by its own `displayKey` (ADR-024 D5; INV-118), with a work area inside its bounds, and exactly
 * one of them is the primary display. `make` answers a provider over two displays.
 */
export function runScreenAreaProviderContract(name: string, make: () => ScreenAreaProvider): void {
  describe(`${name} meets the ScreenAreaProvider contract (16 §4.14)`, () => {
    it('[INV-118] every listed display is answered by its own key: its work area and its bounds', () => {
      const provider = make()
      const displays = provider.displays()
      expect(displays).toHaveLength(2)
      for (const display of displays) {
        expect(provider.workArea(display.displayKey)).toEqual(display.workArea)
        expect(provider.bounds(display.displayKey)).toEqual(display.bounds)
        const { bounds, workArea } = display
        expect(workArea.x).toBeGreaterThanOrEqual(bounds.x)
        expect(workArea.y).toBeGreaterThanOrEqual(bounds.y)
        expect(workArea.x + workArea.width).toBeLessThanOrEqual(bounds.x + bounds.width)
        expect(workArea.y + workArea.height).toBeLessThanOrEqual(bounds.y + bounds.height)
      }
    })

    it('[ADR-024] the display keys are distinct and exactly one display is the primary one', () => {
      const displays = make().displays()
      expect(new Set(displays.map((d) => d.displayKey)).size).toBe(displays.length)
      expect(displays.filter((d) => d.primary)).toHaveLength(1)
    })
  })
}
