import { describe, expect, it } from 'vitest'
import type { AskId } from '../../../kernel/domain/values'
import type { SqliteDatabase } from '../../../kernel/ports/sqliteDatabase'
import { permissionAsk, runAskRepositoryContract } from '../testing/askRepository.contract'
import { answerRows, ASK_T0, seededAskDb } from '../testing/sqliteAskDb'

const T0 = ASK_T0

/**
 * The writer connection, with `between` run once right after the first statement of `settle`
 * returns: a second settle of the same ask lands between the first one's statements, the way two
 * submits interleave when the decision is not one statement (09 §8.2).
 */
function interleaving(db: SqliteDatabase, between: () => void): SqliteDatabase {
  let armed = true
  const fire = <T>(result: T): T => {
    if (armed) {
      armed = false
      between()
    }
    return result
  }
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => fire(db.run(sql, params)),
    all: (sql, params) => fire(db.all(sql, params)),
    openReader: () => db.openReader(),
    close: () => db.close()
  }
}

// L3 (17 §1.3): the contract over a copy of the run's template database (schema v1), so every row
// meets the real CHECKs, UNIQUE keys and foreign keys of `asks` and `ask_answers` (09 §4.5).
describe('SqliteAskRepository', () => {
  runAskRepositoryContract(() => {
    const { runner, open, seedRecord, dwarfs } = seededAskDb()
    return {
      repository: open(),
      dwarfs,
      inTransaction: (work) => runner.inTransaction(work),
      reopen: () => open(),
      seedRecord,
      dispose: () => undefined
    }
  })

  it('[INV-72] two settles of one ask interleaved on the one writer settle it once', () => {
    const { db, runner, open, dwarfs } = seededAskDb()
    const ask = permissionAsk(1, dwarfs[0])
    runner.inTransaction(() => open().save(ask))
    const second = open()
    let secondOutcome: string | null = null
    const first = open(
      interleaving(db, () => {
        secondOutcome = second.settle(ask.id as AskId, { requestId: 'r-second' })
      })
    )

    const firstOutcome = runner.inTransaction(() =>
      first.settle(ask.id as AskId, { requestId: 'r-first' })
    )

    expect([firstOutcome, secondOutcome].sort()).toStrictEqual(['already-settled', 'settled'])
    expect(answerRows(db)).toHaveLength(1)
  })

  // 09 §8.2: the pending answer row of the critical section.
  it('[INV-72] a settle writes answering and one pending ask_answers row stamped by the clock', () => {
    const { db, runner, clock, open, dwarfs } = seededAskDb()
    const ask = permissionAsk(2, dwarfs[0])
    const repository = open()
    runner.inTransaction(() => repository.save(ask))
    clock.advance(1_500)

    runner.inTransaction(() => repository.settle(ask.id as AskId, { requestId: 'r-1' }))
    runner.inTransaction(() => repository.settle(ask.id as AskId, { requestId: 'r-2' }))

    expect(db.all('SELECT state, closed_at FROM asks').map((row) => ({ ...row }))).toStrictEqual([
      { state: 'answering', closed_at: null }
    ])
    expect(answerRows(db)).toStrictEqual([
      {
        request_id: 'r-1',
        ask_id: ask.id,
        outcome: null,
        refusal_reason: null,
        message_id: null,
        at: T0 + 1_500,
        settled_at: null
      }
    ])
  })

  // 16 §2.2: writes join the caller's transaction.
  it('[INV-72] a write outside the caller transaction is refused and stores nothing', () => {
    const { db, open, dwarfs } = seededAskDb()
    const ask = permissionAsk(3, dwarfs[0])
    const repository = open()

    expect(() => repository.save(ask)).toThrow()
    expect(() => repository.settle(ask.id as AskId, { requestId: 'r-1' })).toThrow()
    expect(db.all('SELECT id FROM asks')).toStrictEqual([])
  })

  // Owner amendment K: the ask_answers writes join the caller's transaction too (16 §2.2).
  it('[INV-72] linkRecord and settleAnswer outside the caller transaction are refused and store nothing', () => {
    const { db, runner, open, seedRecord, dwarfs } = seededAskDb()
    const ask = permissionAsk(6, dwarfs[0])
    const repository = open()
    runner.inTransaction(() => {
      repository.save(ask)
      repository.settle(ask.id as AskId, { requestId: 'r-1' })
    })
    const record = seedRecord(dwarfs[0], ask.id as AskId)

    expect(() => repository.linkRecord('r-1', record)).toThrow()
    expect(() => repository.settleAnswer('r-1', { kind: 'accepted' })).toThrow()
    expect(answerRows(db)).toStrictEqual([
      {
        request_id: 'r-1',
        ask_id: ask.id,
        outcome: null,
        refusal_reason: null,
        message_id: null,
        at: T0,
        settled_at: null
      }
    ])
  })

  it('[INV-71] a provider request id holding SQL quotes is stored and found exactly as written', () => {
    const { runner, open, dwarfs } = seededAskDb()
    const tricky = `req'); DELETE FROM asks; --`
    const ask = permissionAsk(5, dwarfs[0], { providerRequestId: tricky })
    const repository = open()
    runner.inTransaction(() => repository.save(ask))

    expect(repository.byProviderRequest({ dwarfId: dwarfs[0] }, tricky)).toStrictEqual(ask)
    expect(repository.openFor(dwarfs[0])).toStrictEqual(ask)
  })

  it('[ADR-010, INV-75] payload_json holds only the redraw text of the card', () => {
    const { db, runner, open, dwarfs } = seededAskDb()
    const ask = permissionAsk(4, dwarfs[0], { currentStep: 0 })
    runner.inTransaction(() => open().save(ask))

    expect(db.all('SELECT payload_json FROM asks').map((row) => ({ ...row }))).toStrictEqual([
      { payload_json: JSON.stringify({ toolName: 'Bash', requestText: 'Run pnpm test' }) }
    ])
  })
})
