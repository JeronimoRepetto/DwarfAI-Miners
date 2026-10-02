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
const SECOND_REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8058'
const REPEATED_REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8059'

/** Every dwarf the outcome reports, sorted, after checking none is reported twice. */
function reportedOnce(outcome: {
  ended: readonly DwarfId[]
  failed: readonly DwarfId[]
}): DwarfId[] {
  const reported = [...outcome.ended, ...outcome.failed]
  expect(new Set(reported).size, 'no dwarf is reported twice').toBe(reported.length)
  return reported.sort()
}

// ADDED for the cut-0 conformance audit (the suite had one case): the semantics of 16 §1 launching `stopAll` beyond the
// first answer. The empty owner of cut 0 is correct by contract, since the Host owns no session yet (ADR-002 D7;
// ISSUE-029), so `{ ended: [], failed: [] }` is its only true answer; these cases fail an empty binding that answers
// anything else, answers only once, or depends on the requestId.
export function runStopAllContract(makeSubject: () => StopAllSubject): void {
  describe('StopAllPort contract', () => {
    it('[INV-120, INV-121] stopAll settles with every owned dwarf in exactly one of ended and failed, and no other dwarf', async () => {
      const { port, owned } = makeSubject()

      const outcome = await port.stopAll(REQUEST_ID)

      const reported = [...outcome.ended, ...outcome.failed]
      expect([...reported].sort()).toEqual([...owned].sort())
      expect(new Set(reported).size).toBe(reported.length)
    })

    it('[INV-121, S12.21] after a settled stopAll, a new request settles again with every owned dwarf reported once', async () => {
      // An incomplete Stop everything leaves the Host running and the person may press it again (S12.21).
      const { port, owned } = makeSubject()

      const first = await port.stopAll(REQUEST_ID)
      const second = await port.stopAll(SECOND_REQUEST_ID)

      expect(reportedOnce(first)).toEqual([...owned].sort())
      expect(reportedOnce(second)).toEqual([...owned].sort())
    })

    it('[ADR-002] two requests with the same requestId, the idempotency key, settle with equal outcomes', async () => {
      const { port } = makeSubject()

      const [first, repeat] = await Promise.all([
        port.stopAll(REPEATED_REQUEST_ID),
        port.stopAll(REPEATED_REQUEST_ID)
      ])

      expect({ ended: [...repeat.ended].sort(), failed: [...repeat.failed].sort() }).toEqual({
        ended: [...first.ended].sort(),
        failed: [...first.failed].sort()
      })
    })
  })
}
