// The DrainGate conformance suite (16 §2.8, 17 §1.3): run against FakeDrainGate and every
// production binding — the empty one of cut 0 (host/wiring/emptyDrainGate.ts) and, later, the
// launching and asking modules' (EPIC-10, EPIC-08).
import { describe, expect, it } from 'vitest'
import type { DrainBlocker, DrainGate } from '../ports/drainGate'

export interface DrainGateSubject {
  gate: DrainGate
  /** What the subject holds open right now. */
  open: readonly DrainBlocker[]
}

export function runDrainGateContract(makeSubject: () => DrainGateSubject): void {
  describe('DrainGate contract', () => {
    it('[ADR-002, S12.15] blockers reports exactly what the subject holds open, and reading it changes nothing', () => {
      const { gate, open } = makeSubject()

      const first = gate.blockers()
      const second = gate.blockers()

      expect([...first]).toEqual([...open])
      expect([...second]).toEqual([...first])
    })
  })
}
