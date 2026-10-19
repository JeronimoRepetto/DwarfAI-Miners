import { describe, expect, it } from 'vitest'
import type { GlobalShortcutRegistry } from './globalShortcutRegistry'

export interface GlobalShortcutRegistrySubject {
  registry: GlobalShortcutRegistry
  /** Another application holds `accel` from now on. */
  takenByAnotherApp(accel: string): void
  /** The person presses `accel`; answers whether a registrant of this process fired. */
  press(accel: string): boolean
}

/**
 * The `GlobalShortcutRegistry` contract (16 §4.14, 16 §2.8; 05 §3.14), run by the double and by the real adapter
 * alike: `register` answers `true` and the combination then fires its callback; it answers `false` when the
 * combination is taken, by another application or by a registrant of this process; `unregister` frees it; and
 * `register` never throws, whatever the string.
 */
export function runGlobalShortcutRegistryContract(
  name: string,
  make: () => GlobalShortcutRegistrySubject
): void {
  const ACCEL = 'Control+Alt+Shift+F11'

  describe(`${name} meets the GlobalShortcutRegistry contract (16 §4.14)`, () => {
    it('[NFR-PLAT-06] a free combination registers and then fires its callback when pressed', () => {
      const subject = make()
      let fired = 0

      expect(subject.registry.register(ACCEL, () => (fired += 1))).toBe(true)

      expect(subject.press(ACCEL)).toBe(true)
      expect(fired).toBe(1)
    })

    it('[NFR-PLAT-06] a combination another application holds answers false and never fires', () => {
      const subject = make()
      subject.takenByAnotherApp(ACCEL)
      let fired = 0

      expect(subject.registry.register(ACCEL, () => (fired += 1))).toBe(false)

      expect(subject.press(ACCEL)).toBe(false)
      expect(fired).toBe(0)
    })

    it('[NFR-PLAT-06] a combination this process holds answers false to a second registrant, and registers again once freed', () => {
      const subject = make()
      const fired: string[] = []
      subject.registry.register(ACCEL, () => fired.push('first'))

      expect(subject.registry.register(ACCEL, () => fired.push('second'))).toBe(false)
      subject.press(ACCEL)
      expect(fired).toEqual(['first'])

      subject.registry.unregister(ACCEL)
      expect(subject.press(ACCEL)).toBe(false)
      expect(subject.registry.register(ACCEL, () => fired.push('second'))).toBe(true)
      subject.press(ACCEL)
      expect(fired).toEqual(['first', 'second'])
    })

    it('[NFR-PLAT-06] register never throws, whatever the string', () => {
      const subject = make()

      for (const accel of ['', 'Not+A+Key', 'Control+Control', '+']) {
        expect(() => subject.registry.register(accel, () => {}), accel).not.toThrow()
      }
    })
  })
}
