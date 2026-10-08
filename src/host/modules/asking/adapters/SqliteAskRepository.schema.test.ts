import { describe, expect, it } from 'vitest'
import type { AskId } from '../../../kernel/domain/values'
import { NodeSqliteDatabase } from '../../../platform/sqlite/NodeSqliteDatabase'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { permissionAsk, questionAsk } from '../testing/askRepository.contract'
import { answerRows, ASK_T0, seededAskDb } from '../testing/sqliteAskDb'
import { ASK_SWEEP_BATCH, CLOSED_ASK_RETENTION_MS, sweepClosedAsks } from './askSweep'
import { SqliteAskRepository } from './SqliteAskRepository'

const DAY = 24 * 60 * 60 * 1000

// L5 (17 §1.5): the asks rules that live in schema v1 itself (09 §4.5, §7.1, §8.2), proved on a
// copy of the run's template database.
describe('SqliteAskRepository schema', () => {
  it('[INV-72] the asks_one_answering index refuses a second answering ask of the same dwarf even if code regressed', () => {
    const { db, runner, open, dwarfs } = seededAskDb()
    const [dwarf, other] = dwarfs
    const repository = open()
    runner.inTransaction(() => repository.save(permissionAsk(1, dwarf, { state: 'answering' })))

    // A regressed broker that skipped `settle` and saved a second answering ask directly.
    expect(() =>
      runner.inTransaction(() => repository.save(permissionAsk(2, dwarf, { state: 'answering' })))
    ).toThrow(/SQLITE_CONSTRAINT|UNIQUE/)
    runner.inTransaction(() => repository.save(permissionAsk(3, other, { state: 'answering' })))

    expect(
      db.all('SELECT id, state FROM asks ORDER BY id').map((row) => ({ ...row }))
    ).toStrictEqual([
      { id: permissionAsk(1, dwarf).id, state: 'answering' },
      { id: permissionAsk(3, other).id, state: 'answering' }
    ])
  })

  it('[ADR-010] closed asks older than 7 days are swept with their ask_answers and attention keys, younger ones kept', () => {
    const { db, runner, clock, open, dwarfs } = seededAskDb()
    const [dwarf, other] = dwarfs
    const repository = open()
    const old = permissionAsk(1, dwarf)
    const young = permissionAsk(2, dwarf)
    const openOld = questionAsk(3, other)
    const answeringOld = permissionAsk(4, other)
    runner.inTransaction(() => {
      for (const ask of [old, young, openOld, answeringOld]) repository.save(ask)
      repository.settle(old.id as AskId, { requestId: 'r-old' })
      repository.settle(answeringOld.id as AskId, { requestId: 'r-answering' })
      for (const ask of [old, young]) {
        db.run(
          `INSERT INTO attention_keys (key, dwarf_id, kind, ask_id, host_epoch, emitted_at)
           VALUES (?, ?, 'permission', ?, 'epoch-1', ?)`,
          [`${dwarf}:permission:${ask.id}`, dwarf, ask.id, ASK_T0]
        )
      }
    })
    runner.inTransaction(() =>
      repository.save({ ...old, state: 'answered-in-app', closedAt: ASK_T0 + 10 })
    )
    clock.advance(DAY)
    runner.inTransaction(() =>
      repository.save({ ...young, state: 'cancelled', closedAt: clock.now() })
    )

    // `old` closed exactly 7 days ago: "older than" is strict, it waits for the next sweep.
    clock.advance(CLOSED_ASK_RETENTION_MS - DAY + 10)
    expect(sweepClosedAsks({ db, transactions: runner, clock })).toBe(0)

    clock.advance(1)
    expect(sweepClosedAsks({ db, transactions: runner, clock })).toBe(1)

    expect(db.all('SELECT id FROM asks ORDER BY id').map((row) => row['id'])).toStrictEqual([
      young.id,
      openOld.id,
      answeringOld.id
    ])
    expect(answerRows(db).map((row) => row['request_id'])).toStrictEqual(['r-answering'])
    expect(db.all('SELECT ask_id FROM attention_keys').map((row) => row['ask_id'])).toStrictEqual([
      young.id
    ])
  })

  it('[ADR-010] the sweep deletes in bounded batches until fewer than a batch remain', () => {
    const { db, runner, clock, open, dwarfs } = seededAskDb()
    const repository = open()
    const count = ASK_SWEEP_BATCH + 5
    runner.inTransaction(() => {
      for (let n = 1; n <= count; n++) {
        repository.save(
          permissionAsk(n, dwarfs[n % 2]!, { state: 'cancelled', closedAt: ASK_T0 + n })
        )
      }
    })
    clock.advance(CLOSED_ASK_RETENTION_MS + count + 1)

    expect(sweepClosedAsks({ db, transactions: runner, clock })).toBe(count)
    expect(db.all('SELECT count(*) AS n FROM asks').map((row) => row['n'])).toStrictEqual([0])
  })

  it('[FM-017, S6.18] after a simulated Host restart an answering ask of a session that did not survive can be moved to closed-by-death in one transaction', () => {
    const { path, runner, clock, open, dwarfs } = seededAskDb()
    const [dwarf] = dwarfs
    const ask = questionAsk(1, dwarf, { currentStep: 1 })
    const before = open()
    runner.inTransaction(() => {
      before.save(ask)
      before.settle(ask.id as AskId, { requestId: 'r-1' })
    })

    // The next Host boot opens its own writer on the same file (the first one stays idle and is
    // closed when the test ends).
    const restarted = NodeSqliteDatabase.open(path)
    try {
      const runnerAfter = new SqliteTransactionRunner(restarted)
      const after = new SqliteAskRepository({ db: restarted, scope: runnerAfter, clock })
      const found = after.openFor(dwarf)
      expect(found).toStrictEqual({ ...ask, state: 'answering' })

      clock.advance(5_000)
      runnerAfter.inTransaction(() =>
        after.save({ ...ask, state: 'closed-by-death', closedAt: clock.now() })
      )

      expect(after.openFor(dwarf)).toBeNull()
      expect(after.byProviderRequest({ dwarfId: dwarf }, 'request-1')).toStrictEqual({
        ...ask,
        state: 'closed-by-death',
        closedAt: ASK_T0 + 5_000
      })
      // The pending answer stays pending: its result transaction reports `ask-closed` (09 §8.2).
      expect(answerRows(restarted)).toHaveLength(1)
    } finally {
      restarted.close()
    }
  })
})
