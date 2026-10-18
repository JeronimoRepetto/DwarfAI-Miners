import { describe, expect, it } from 'vitest'
import type { CandidateLoginEntry } from './candidateLoginEntry'

export interface CandidateLoginEntrySubject {
  entry: CandidateLoginEntry
  /** Whether the OS holds the entry under the current name. */
  starts(): Promise<boolean>
  /** The OS refuses every write from now on (policy, security software, a read-only folder). */
  refuseWrites(): void
  /** Seeds a pre-rename `AgentName` entry; only where one could exist (Windows, and the double). */
  seedLegacy?(): void
  /** Whether the pre-rename entry is still there. */
  legacy?(): Promise<boolean>
}

/**
 * The `CandidateLoginEntry` contract (16 §2.8 rule: the double and the real adapter run the same suite): `enable` writes
 * the entry and is idempotent, a write the OS refuses rejects (so the default marker is not written), and a migration
 * with no pre-rename entry writes nothing; where a pre-rename entry can exist, the migration moves it to the new name.
 */
export function runCandidateLoginEntryContract(
  name: string,
  make: () => CandidateLoginEntrySubject
): void {
  describe(`${name} meets the CandidateLoginEntry contract (21 §2 cut 1)`, () => {
    it('[ADR-027] enable writes the entry and a second enable keeps it', async () => {
      const { entry, starts } = make()
      expect(await starts()).toBe(false)

      await entry.enable()
      await entry.enable()

      expect(await starts()).toBe(true)
    })

    it('[ADR-027] a write the OS refuses rejects and leaves no entry', async () => {
      const subject = make()
      subject.refuseWrites()

      await expect(subject.entry.enable()).rejects.toBeDefined()

      expect(await subject.starts()).toBe(false)
    })

    it('[ADR-027] a migration with no pre-rename entry writes nothing', async () => {
      const { entry, starts } = make()

      await entry.migrateLegacy()

      expect(await starts()).toBe(false)
    })

    it('[ADR-027] where a pre-rename entry exists, the migration removes it and writes the entry under the new name', async () => {
      const subject = make()
      if (subject.seedLegacy === undefined || subject.legacy === undefined) return
      subject.seedLegacy()

      await subject.entry.migrateLegacy()

      expect(await subject.legacy()).toBe(false)
      expect(await subject.starts()).toBe(true)
    })
  })
}
