// layer: L5
// L5 (17 §1.5): the database backstops of the ledger (09 §4.7) on a copy of the template database:
// `ledger_entries_immutable` (INV-99), the coal CHECK (INV-95; the transplanted
// `ledger.test.ts:166` at the schema level) and the `material_totals` triggers (ADR-006 item 9).
// The schema is migration 1's; these cases pin what the ledger relies on.
import { describe, expect, it } from 'vitest'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import { MATERIALS, type Material } from '../domain/materials'
import { sqliteLedgerSeeds } from '../testing/sqliteLedgerSeeds'

function ledgerDb() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  const seeds = sqliteLedgerSeeds(db, runner)
  const mine = seeds.addMine('copper')
  let n = 0
  const insert = (material: Material, tokens: number, kind: 'live' | 'coal-backfill'): void => {
    n += 1
    const id = `00000000-0000-7000-8000-${(0x76e000 + n).toString(16).padStart(12, '0')}`
    runner.inTransaction(() =>
      db.run(
        `INSERT INTO ledger_entries (id, unit_key, mine_id, material, tokens, units, kind, credited_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, 0)`,
        [id, `unit-${n}`, mine, material, tokens, kind]
      )
    )
  }
  const totals = () =>
    Object.fromEntries(
      db
        .all('SELECT material, tokens FROM material_totals WHERE mine_id = ?', [mine])
        .map((row) => [String(row['material']), Number(row['tokens'])])
    )
  const sums = () =>
    Object.fromEntries(
      db
        .all(
          'SELECT material, SUM(tokens) AS tokens FROM ledger_entries WHERE mine_id = ? GROUP BY material',
          [mine]
        )
        .map((row) => [String(row['material']), Number(row['tokens'])])
    )
  return { db, runner, insert, totals, sums }
}

describe('the ledger triggers and CHECKs (09 §4.7)', () => {
  it('[INV-99] an update of a ledger entry is rejected', () => {
    const l = ledgerDb()
    l.insert('copper', 30_000, 'live')
    expect(() =>
      l.runner.inTransaction(() => l.db.run('UPDATE ledger_entries SET tokens = tokens + 1'))
    ).toThrow(/LEDGER_ENTRY_IMMUTABLE/)
    expect(l.totals()).toEqual({ copper: 30_000 })
  })

  it('[INV-95] a coal material with kind live is rejected by the CHECK', () => {
    const l = ledgerDb()
    expect(() => l.insert('coal', 5_000, 'live')).toThrow(/CHECK/)
    expect(() => l.insert('bronze', 5_000, 'coal-backfill')).toThrow(/CHECK/)
    l.insert('coal', 5_000, 'coal-backfill')
    expect(l.totals()).toEqual({ coal: 5_000 })
  })

  it('[ADR-006] material_totals equals SUM of ledger_entries after every insert', () => {
    const l = ledgerDb()
    const credits: Array<[Material, number, 'live' | 'coal-backfill']> = [
      ['copper', 30_000, 'live'],
      ['coal', 2_600, 'coal-backfill'],
      ['copper', 1, 'live'],
      ['gold', 100_000, 'live'],
      ['coal', 7, 'coal-backfill']
    ]
    for (const [material, tokens, kind] of credits) {
      l.insert(material, tokens, kind)
      expect(l.totals()).toEqual(l.sums())
    }
    expect(Object.keys(l.totals()).every((m) => MATERIALS.includes(m as Material))).toBe(true)
  })
})
