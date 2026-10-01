// The StopAllPort conformance suite (16 §2.8, 17 §1.3): run against RecordingStopAll and every
// production binding — the empty-owner one of cut 0 (host/wiring/emptyOwnerStopAll.ts) and,
// later, the launching module's (later: ISSUE-175).
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../contracts/wire'
import type { StopAllPort } from '../ports/stopAll'

export interface StopAllSubject {
  port: StopAllPort
  /** The dwarfs whose sessions the subject owns. */
  owned: readonly DwarfId[]
}

const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'

export function runStopAllContract(makeSubject: () => StopAllSubject): void {
  describe('StopAllPort contract', () => {
    it('[INV-120, INV-121] stopAll settles with every owned dwarf in exactly one of ended and failed, and no other dwarf', async () => {
      const { port, owned } = makeSubject()

      const outcome = await port.stopAll(REQUEST_ID)

      const reported = [...outcome.ended, ...outcome.failed]
      expect([...reported].sort()).toEqual([...owned].sort())
      expect(new Set(reported).size).toBe(reported.length)
    })
  })
}
