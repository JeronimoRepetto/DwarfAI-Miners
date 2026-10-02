import { describe, expect, it } from 'vitest'
import { FakeClock } from '../kernel/fakes/FakeClock'
import type { TransactionRunner } from '../kernel/ports/transactionRunner'
import type { ResetDbStep } from '../modules/preferences'
import { resetParticipants } from './resetParticipants'

// L2 (17 §1.2): the Reset saga's participant list (ADR-023 item 4; 09 §7.2; lead decision
// 2026-09-30: the ledger's install moment is a `ResetDbStep`-shaped step registered here).

/** A transaction runner that records whether `work` ran inside it. */
function recordingRunner(): TransactionRunner & { runs: number; open: boolean } {
  const runner = {
    runs: 0,
    open: false,
    inTransaction<T>(work: () => T): T {
      runner.runs += 1
      runner.open = true
      try {
        return work()
      } finally {
        runner.open = false
      }
    }
  }
  return runner
}

describe('resetParticipants', () => {
  it('[ADR-023, S13.05] the db transaction runs the preferences step and the install-moment step writes install_moment now through the ledger in its own transaction', () => {
    const clock = new FakeClock(1_750_000_000_000)
    const preferences: ResetDbStep = { name: 'preferences', reset: () => undefined }
    const written: Array<{ at: number; inTransaction: boolean }> = []
    const tx = recordingRunner()
    const participants = resetParticipants({
      preferences,
      ledger: { setInstallMoment: (at) => written.push({ at, inTransaction: tx.open }) },
      clock
    })

    expect(participants.dbSteps).toStrictEqual([preferences])
    expect(participants.installMoment.name).toBe('ledger-install-moment')
    clock.advance(42)
    participants.installMoment.reset(tx)
    expect(written).toStrictEqual([{ at: 1_750_000_000_042, inTransaction: true }])
    expect(tx.runs).toBe(1)
  })
})
