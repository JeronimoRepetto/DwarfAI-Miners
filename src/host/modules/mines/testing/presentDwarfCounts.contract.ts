// The interim `PresentDwarfCounts` read (application/mineQueries.ts; replaced by the crew edge in
// ISSUE-094), run on the in-memory double and on the SQLite adapter: a dwarf counts in its mine
// until it departs (INV-26: `departedAt` set), and a mine with no present dwarf counts none.
import { afterEach, describe, expect, it } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import type { PresentDwarfCounts } from '../application/mineQueries'

export interface PresentDwarfCountsSubject {
  counts: PresentDwarfCounts
  /** Three mines that exist in the subject's store. */
  mineIds: readonly [MineId, MineId, MineId]
  /** Seats one dwarf in `mineId`, present or already departed. */
  seatDwarf(mineId: MineId, present: boolean): void
  dispose(): void | Promise<void>
}

export function runPresentDwarfCountsContract(
  makeSubject: () => PresentDwarfCountsSubject | Promise<PresentDwarfCountsSubject>
): void {
  describe('PresentDwarfCounts contract (interim, until ISSUE-094)', () => {
    let subject: PresentDwarfCountsSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    it('[INV-26] present dwarfs per mine count only the dwarfs that have not departed', async () => {
      subject = await makeSubject()
      const [busy, quiet, empty] = subject.mineIds
      subject.seatDwarf(busy, true)
      subject.seatDwarf(busy, true)
      subject.seatDwarf(busy, false)
      subject.seatDwarf(quiet, false)

      const counts = subject.counts.presentDwarfsIn([busy, quiet, empty])

      expect(counts.get(busy)).toBe(2)
      expect(counts.get(quiet) ?? 0).toBe(0)
      expect(counts.get(empty) ?? 0).toBe(0)
      expect(subject.counts.presentDwarfsIn([quiet]).get(busy)).toBeUndefined()
      expect(subject.counts.presentDwarfsIn([]).size).toBe(0)
    })
  })
}
