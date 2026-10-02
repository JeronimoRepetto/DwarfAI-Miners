import { describe, expect, it } from 'vitest'
import type { AutostartPort } from './autostartPort'

export interface AutostartSubject {
  autostart: AutostartPort
  /** How many times the OS's login entry was written so far (created, rewritten or re-enabled). */
  writes(): number
  /** The person disables the entry in the OS's own startup list (Windows "Startup apps", macOS Login Items, XDG). */
  disableInOs(): void
  /** The OS refuses every write and removal of the entry from now on (policy, security software, a read-only folder). */
  refuseWrites(): void
}

/**
 * The `AutostartPort` contract (16 §4.14, 16 §2.8; ADR-027 item 7; 13 FM-147), run by the double and by the real
 * adapter alike: `set(true)` then `get()` reads the entry back, `set(false)` removes it, both idempotent; an entry the
 * person disabled in the OS's startup list reads `false` and `set(true)` writes nothing over it (DwarfAI never
 * re-enables it); a write or removal the OS refuses throws and leaves the real state readable.
 */
export function runAutostartContract(name: string, make: () => AutostartSubject): void {
  describe(`${name} meets the AutostartPort contract (16 §4.14)`, () => {
    it('[S-027-4] set true then get reads the entry back; set false removes it; each is idempotent', () => {
      const { autostart } = make()
      expect(autostart.get()).toBe(false)

      autostart.set(true)
      autostart.set(true)
      expect(autostart.get()).toBe(true)

      autostart.set(false)
      expect(autostart.get()).toBe(false)
      autostart.set(false)
      expect(autostart.get()).toBe(false)
    })

    it('[S40.08] an entry disabled in the OS startup list reads false and set true writes nothing over it', () => {
      const subject = make()
      subject.autostart.set(true)
      const written = subject.writes()
      subject.disableInOs()

      expect(subject.autostart.get()).toBe(false)
      subject.autostart.set(true)
      expect(subject.autostart.get()).toBe(false)
      expect(subject.writes()).toBe(written)
    })

    it('[FM-147] a write or a removal the OS refuses throws, and get reads the real state', () => {
      const off = make()
      off.refuseWrites()
      expect(() => off.autostart.set(true)).toThrow()
      expect(off.autostart.get()).toBe(false)

      const on = make()
      on.autostart.set(true)
      on.refuseWrites()
      expect(() => on.autostart.set(false)).toThrow()
      expect(on.autostart.get()).toBe(true)
    })
  })
}
