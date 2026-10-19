import { describe, expect, it } from 'vitest'
import type { WindowFactory } from './windowFactory'

/**
 * The `WindowFactory` contract (16 §4.14, 16 §2.8), run by the double and by the real adapter alike: one Panel window
 * at a time (INV-116), handed back as long as it is open, with exactly the `ModeWindow` members the `ModeCoordinator`
 * needs (ADR-025 item 3; AMENDMENT-10).
 */
export function runWindowFactoryContract(name: string, make: () => WindowFactory): void {
  describe(`${name} meets the WindowFactory contract (16 §4.14)`, () => {
    it('[INV-116] asking for the Panel again returns the one Panel window while it is open', () => {
      const factory = make()
      expect(factory.panel()).toBe(factory.panel())
    })

    it('[ADR-019] the Panel window has exactly the ModeWindow members', () => {
      const panel = make().panel()
      for (const member of ['placeAt', 'showInactive', 'hide', 'focus', 'send'] as const) {
        expect(typeof panel[member], member).toBe('function')
      }
    })
  })
}
