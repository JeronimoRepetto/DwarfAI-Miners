// The SessionTerminator conformance suite (16 §4.2 row `SessionTerminator`: "fake contract: custom
// name never in any call", NFR-PRIV-03, 05 §3.2; 17 §1.3): run on `FakeSessionTerminator` and on
// the `host/wiring` bridge. The per-OS kill behaviour is the bridge's own L3 and L8 tests (ADR-014
// Verification); this suite holds what every implementation shares.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { SessionTerminator } from '../ports/sessionTerminator'

export interface SessionTerminatorSubject {
  terminator: SessionTerminator
  /**
   * Seats a present dwarf in `mineId` whose session the subject can end, named `customName` by
   * the person (OQ-27), and answers its id.
   */
  seat(input: { mineId: MineId; customName: string }): DwarfId
  /**
   * The arguments of every call the subject made or received (each outside port it called, and
   * for a double the calls it was given), in order.
   */
  calls(): readonly unknown[]
}

const MINE_A = '00000000-0000-7000-8000-00000000a001' as MineId
const MINE_B = '00000000-0000-7000-8000-00000000b001' as MineId
const CUSTOM_NAME = 'Gimli Stonehelm'

export function runSessionTerminatorContract(make: () => SessionTerminatorSubject): void {
  describe('SessionTerminator contract', () => {
    it('[NFR-PRIV-03] no terminator call carries a custom name', async () => {
      const subject = make()
      const first = subject.seat({ mineId: MINE_A, customName: CUSTOM_NAME })
      subject.seat({ mineId: MINE_A, customName: `${CUSTOM_NAME} the Second` })

      await subject.terminator.end(first, 'stop-dwarf')
      await subject.terminator.endAll(MINE_A)

      const calls = subject.calls()
      expect(calls.length).toBeGreaterThan(0)
      expect(JSON.stringify(calls)).not.toContain('Gimli')
    })

    it('[ADR-014] endAll answers one outcome for each present dwarf of the mine and none for another mine', async () => {
      const subject = make()
      const a1 = subject.seat({ mineId: MINE_A, customName: 'a1' })
      const a2 = subject.seat({ mineId: MINE_A, customName: 'a2' })
      const b1 = subject.seat({ mineId: MINE_B, customName: 'b1' })

      const outcomes = await subject.terminator.endAll(MINE_A)

      expect([...outcomes.keys()].sort()).toEqual([a1, a2].sort())
      expect(outcomes.has(b1)).toBe(false)
    })
  })
}
