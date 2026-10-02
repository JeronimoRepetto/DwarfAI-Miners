import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { SqliteResetJournal } from './SqliteResetJournal'

// L3 (17 §1.3; 16 §4.12 row `ResetJournal`): the real journal over a copy of the run's template
// database (schema v1, migration 1 seeded), so every row meets the real CHECKs and the
// `reset_journal_one_active` index of 09 §4.1.

const T = 1_750_000_000_000

function journal() {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T)
  const subject = new SqliteResetJournal({ db, clock, ids: new SequenceIdGenerator() })
  const row = (id: string) => db.all('SELECT * FROM reset_journal WHERE id = ?', [id])[0]
  const appMeta = () => ({ ...db.all('SELECT reset_epoch, welcome_answered_at FROM app_meta')[0] })
  return { db, transactions, clock, subject, row, appMeta }
}

describe('SqliteResetJournal', () => {
  it('[ADR-023, INV-108] begin writes the row at db, bumps the reset epoch and clears the first-run answer, all in the caller transaction', () => {
    const { db, transactions, subject, row, appMeta } = journal()
    transactions.inTransaction(() =>
      db.run('UPDATE app_meta SET reset_epoch = 4, welcome_answered_at = ?', [T - 1])
    )

    const started = transactions.inTransaction(() => subject.begin(transactions))

    expect(started.epoch).toBe(5)
    expect(started.id).toHaveLength(36)
    expect(row(started.id)).toMatchObject({
      epoch: 5,
      step: 'db',
      started_at: T,
      step_at: T,
      finished_at: null,
      last_failure: null
    })
    expect(appMeta()).toStrictEqual({ reset_epoch: 5, welcome_answered_at: null })
    expect(subject.step(started.id)).toBe('db')

    // The caller's transaction rolled back: nothing of a later begin stays (16 §2.2 "join").
    subject.advance(started.id, 'done')
    expect(() =>
      transactions.inTransaction(() => {
        subject.begin(transactions)
        throw new Error('a later ResetDbStep failed')
      })
    ).toThrow('a later ResetDbStep failed')
    expect(appMeta()).toStrictEqual({ reset_epoch: 5, welcome_answered_at: null })
    expect(db.all('SELECT count(*) AS n FROM reset_journal')[0]?.['n']).toBe(1)
  })

  it('[S13.02, S13.06] advance moves the journal forward only, writes finished_at at done, and repeating a step changes nothing', () => {
    const { transactions, clock, subject, row } = journal()
    const { id } = transactions.inTransaction(() => subject.begin(transactions))

    clock.advance(1_000)
    subject.advance(id, 'secrets')
    expect(subject.step(id)).toBe('secrets')
    expect(row(id)).toMatchObject({ step: 'secrets', step_at: T + 1_000, finished_at: null })

    clock.advance(1_000)
    subject.advance(id, 'secrets')
    subject.advance(id, 'db')
    expect(row(id)).toMatchObject({ step: 'secrets', step_at: T + 1_000 })

    subject.advance(id, 'done')
    expect(row(id)).toMatchObject({ step: 'done', step_at: T + 2_000, finished_at: T + 2_000 })
  })

  it('[ADR-023] a second unfinished saga is refused, and a finished one lets the next begin', () => {
    const { transactions, subject } = journal()
    const first = transactions.inTransaction(() => subject.begin(transactions))

    expect(() => transactions.inTransaction(() => subject.begin(transactions))).toThrow()

    subject.advance(first.id, 'done')
    const second = transactions.inTransaction(() => subject.begin(transactions))
    expect(second.epoch).toBe(first.epoch + 1)
    expect(subject.step(second.id)).toBe('db')
    expect(() => subject.step('00000000-0000-7000-8000-0000000000ff')).toThrow()
  })

  it('[S13.08, S13.07] unfinished finds the one saga not done and fail records the reason of its failed step', () => {
    const { transactions, clock, subject, row } = journal()
    expect(subject.unfinished()).toBeNull()
    const first = transactions.inTransaction(() => subject.begin(transactions))
    subject.advance(first.id, 'done')
    expect(subject.unfinished()).toBeNull()

    const second = transactions.inTransaction(() => subject.begin(transactions))
    clock.advance(1_000)
    subject.advance(second.id, 'secrets')
    subject.fail(second.id, 'config-revert-locked')

    expect(subject.unfinished()).toStrictEqual({ id: second.id, epoch: 2, step: 'secrets' })
    expect(row(second.id)).toMatchObject({
      step: 'secrets',
      step_at: T + 1_000,
      last_failure: 'config-revert-locked'
    })
    // A later failure replaces the reason; the step stays where it was (nothing is rolled back).
    subject.fail(second.id, 'secret-delete-failed')
    expect(row(second.id)).toMatchObject({ step: 'secrets', last_failure: 'secret-delete-failed' })
    expect(() => subject.fail('00000000-0000-7000-8000-0000000000ff', 'x')).toThrow()
  })
})
