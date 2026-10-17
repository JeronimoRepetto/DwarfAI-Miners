import type { DwarfId } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { runRecoveryReportStoreContract } from '../../testing/recoveryReportStore.contract'
import { seedDwarf, seedMine, T0 } from '../../testing/sqliteLaunchingDb'
import { SqliteRecoveryReportStore } from './SqliteRecoveryReportStore'

// L3 (17 §1.3): the contract over a copy of the run's template database, so every row meets the
// real CHECKs and foreign keys of `host_recovery_reports` and `host_recovery_items` (09 §4.3).
const DWARFS = [
  '00000000-0000-7000-8000-0000000173d1' as DwarfId,
  '00000000-0000-7000-8000-0000000173d2' as DwarfId,
  '00000000-0000-7000-8000-0000000173d3' as DwarfId
] as const

runRecoveryReportStoreContract(() => {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  seedMine(db, runner)
  for (const dwarfId of DWARFS) seedDwarf(db, runner, dwarfId)
  return {
    store: new SqliteRecoveryReportStore({ db, scope: runner, clock: new FakeClock(T0) }),
    dwarfs: DWARFS,
    retryOutcome: (epoch, dwarfId) => {
      const [row] = db.all(
        'SELECT retry_outcome FROM host_recovery_items WHERE host_epoch = ? AND dwarf_id = ?',
        [epoch, dwarfId]
      )
      const outcome = row?.['retry_outcome']
      return outcome === 'resumed' || outcome === 'failed' ? outcome : null
    },
    shownAt: (epoch) => {
      const [row] = db.all('SELECT shown_at FROM host_recovery_reports WHERE host_epoch = ?', [
        epoch
      ])
      return row === undefined || row['shown_at'] === null ? null : Number(row['shown_at'])
    },
    inTransaction: (work) => runner.inTransaction(work),
    dispose: () => db.close()
  }
})
