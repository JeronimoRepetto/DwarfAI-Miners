// layer: L3
// L3 (17 §1.3): the LedgerRepository contract over a copy of the run's template database (schema
// v1, migration 1 applied), so every row meets the real CHECKs, UNIQUE keys, foreign keys and the
// `material_totals` triggers of 09 §4.7.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { runLedgerRepositoryContract } from '../testing/ledgerRepository.contract'
import { sqliteLedgerSeeds } from '../testing/sqliteLedgerSeeds'
import { SqliteLedgerRepository } from './SqliteLedgerRepository'

describe('SqliteLedgerRepository', () => {
  runLedgerRepositoryContract(() => {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    const ids = new SequenceIdGenerator()
    const clock = new FakeClock(1_760_000_000_000)
    const seeds = sqliteLedgerSeeds(db, runner)
    return {
      repository: new SqliteLedgerRepository({ db, scope: runner, ids, clock }),
      inTransaction: (work) => runner.inTransaction(work),
      addMine: seeds.addMine,
      addDwarf: seeds.addDwarf,
      setInstallMoment: seeds.setInstallMoment,
      setResetInProgress: seeds.setResetInProgress,
      entries: seeds.entries,
      entryIds: seeds.entryIds,
      dispose: () => undefined
    }
  })
})

// The install-moment writer of the Reset saga's `install-moment` step (16 §4.10
// `setInstallMoment(t)`; 07 S13.05, S19.01; 09 §7.2 row `install_moment`), wired by
// host/wiring/resetParticipants.ts (ISSUE-121).
describe('SqliteLedgerRepository.setInstallMoment', () => {
  const OLD = 1_760_000_000_000
  const NEW = 1_760_000_500_000

  function seeded() {
    const { db } = openTemplateCopy()
    const runner = new SqliteTransactionRunner(db)
    const ids = new SequenceIdGenerator()
    const clock = new FakeClock(NEW)
    runner.inTransaction(() => {
      db.run('DELETE FROM install_moment')
      db.run(
        `INSERT INTO install_moment (id, at, reason, backfill_state, backfill_done_at)
         VALUES (1, ?, 'fresh-install', 'done', ?)`,
        [OLD, OLD + 1]
      )
      db.run(
        `INSERT INTO coal_backfill_units (scan_unit, adapter_id, tokens_credited, credited_at)
         VALUES ('claude-project-1', 'claude', 77, ?)`,
        [OLD]
      )
    })
    const repository = new SqliteLedgerRepository({ db, scope: runner, ids, clock })
    const moment = () =>
      db
        .all('SELECT at, reason, backfill_state, backfill_done_at FROM install_moment')
        .map((row) => ({ ...row }))
    const scanUnits = () => db.all('SELECT scan_unit FROM coal_backfill_units').length
    return { runner, repository, moment, scanUnits }
  }

  it("[S13.05, S19.01] the reset moment is written in the caller's transaction and the old moment's scan units go with it", () => {
    const { runner, repository, moment, scanUnits } = seeded()

    runner.inTransaction(() => repository.setInstallMoment(NEW))

    expect(moment()).toStrictEqual([
      { at: NEW, reason: 'reset', backfill_state: 'not-started', backfill_done_at: null }
    ])
    expect(repository.installMoment()).toBe(NEW)
    expect(repository.backfillState()).toStrictEqual({
      state: 'not-started',
      creditedScanUnits: []
    })
    expect(scanUnits()).toBe(0)
  })

  it('[S13.05] outside a transaction it throws and writes nothing', () => {
    const { repository, moment, scanUnits } = seeded()

    expect(() => repository.setInstallMoment(NEW)).toThrow(HostInvariantError)

    expect(moment()).toStrictEqual([
      { at: OLD, reason: 'fresh-install', backfill_state: 'done', backfill_done_at: OLD + 1 }
    ])
    expect(scanUnits()).toBe(1)
  })
})
