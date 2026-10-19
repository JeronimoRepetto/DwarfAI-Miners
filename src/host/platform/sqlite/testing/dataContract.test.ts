import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { initialMigration } from '../migrations/0001-initial'
import { checkDataContract } from './dataContract'
import { MemoryWritableSqlite } from './MemoryWritableSqlite'

// L5 (17 §1.5; 09 §6.5 "Fixture ladder", "Invariant triggers"): the checks the ladder runs after
// each rung is migrated must see a broken database, or a ladder rung could pass without proving
// anything.

const T0 = 1_750_000_000_000
const MINE = '00000000-0000-7000-8000-0000000000f1'
const GHOST_MINE = '00000000-0000-7000-8000-0000000000f9'

describe('the data contract of a migrated rung', () => {
  let db: MemoryWritableSqlite

  beforeEach(() => {
    db = new MemoryWritableSqlite()
    db.exec('BEGIN')
    initialMigration({ clock: new FakeClock(T0), ids: new SequenceIdGenerator() }).up(db)
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-one', 'mine-one', 'mine-one', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    db.run(
      `INSERT INTO ledger_entries (id, unit_key, mine_id, material, tokens, units, kind, credited_at)
       VALUES ('00000000-0000-7000-8000-0000000000e1', 'unit-1', ?, 'bronze', 1200, 1, 'live', ?)`,
      [MINE, T0]
    )
    db.exec('COMMIT')
  })

  afterEach(() => {
    db.close()
  })

  it('[ADR-005] a consistent database passes the data contract', () => {
    expect(checkDataContract(db)).toEqual([])
  })

  it('[ADR-005] the data contract reports a material_totals row that differs from SUM(ledger_entries)', () => {
    db.run("UPDATE material_totals SET tokens = 999 WHERE mine_id = ? AND material = 'bronze'", [
      MINE
    ])

    expect(checkDataContract(db)).toEqual([
      `material_totals (${MINE}, bronze) holds 999 tokens and 1 units; SUM(ledger_entries) is 1200 tokens and 1 units`
    ])
  })

  it('[ADR-005] the data contract reports a foreign key that points at no row', () => {
    db.exec('PRAGMA foreign_keys = OFF')
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at)
       VALUES ('00000000-0000-7000-8000-0000000000d1', ?, 'claude', 's-1', 'Dwarf', 'foreman',
         'running', 'none-yet', ?, ?)`,
      [GHOST_MINE, T0, T0]
    )
    db.exec('PRAGMA foreign_keys = ON')

    expect(checkDataContract(db)).toEqual(['foreign_key_check: dwarfs row 1 → mines'])
  })
})
