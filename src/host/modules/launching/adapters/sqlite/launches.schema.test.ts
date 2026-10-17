import { describe, expect, it } from 'vitest'
import { SqliteInfrastructureError } from '../../../../kernel/domain/errors'
import type { SqliteDatabase, SqliteParam } from '../../../../kernel/ports/sqliteDatabase'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { MINE, MINE_FOLDER, T0, seedMine } from '../../testing/sqliteLaunchingDb'

// L5 (17 §1.5; 09 §6.5) schema probes over migration 1, kept with the launching stores that rely on
// them (lead decision, ISSUE-161: `platform/sqlite/schema.contract.test.ts` is ISSUE-036's file and
// stays untouched here). The CHECKs of `launches` (09 §4.3) are what make INV-52 hold in storage.
let sequence = 0

function insertLaunch(db: SqliteDatabase, columns: Record<string, SqliteParam>): void {
  const row: Record<string, SqliteParam> = {
    id: `00000000-0000-7000-8161-5c4e${(++sequence).toString(16).padStart(8, '0')}`,
    mine_id: MINE,
    cwd: MINE_FOLDER,
    way_kind: 'supplier',
    provider_id: 'claude',
    launched_with_let_jev_choose: 0,
    state: 'resolving',
    delegated: 0,
    host_epoch: 'epoch-0161',
    requested_at: T0,
    ...columns
  }
  const names = Object.keys(row)
  new SqliteTransactionRunner(db).inTransaction(() =>
    db.run(
      `INSERT INTO launches (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      Object.values(row)
    )
  )
}

describe('launches schema (09 §4.3)', () => {
  it('[ADR-005] launches rejects a failed row without a cause and a jev cause without a jev reason', () => {
    const { db } = openTemplateCopy()
    seedMine(db, new SqliteTransactionRunner(db))
    const failed = { state: 'failed', settled_at: T0 + 1 }
    const letJevChoose = { way_kind: 'jev', provider_id: null, launched_with_let_jev_choose: 1 }

    insertLaunch(db, { ...failed, failure_cause: 'could-not-start' })
    insertLaunch(db, {
      ...failed,
      ...letJevChoose,
      failure_cause: 'jev-could-not-choose',
      jev_reason: 'no-launchable-provider'
    })

    expect(() => insertLaunch(db, failed)).toThrow(SqliteInfrastructureError)
    expect(() => insertLaunch(db, failed)).toThrow(/CHECK constraint failed/)
    expect(() =>
      insertLaunch(db, { ...failed, ...letJevChoose, failure_cause: 'jev-unreachable' })
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      insertLaunch(db, { ...failed, ...letJevChoose, failure_cause: 'jev-could-not-choose' })
    ).toThrow(/CHECK constraint failed/)
    expect(db.all("SELECT failure_cause FROM launches WHERE state = 'failed' ORDER BY id")).toEqual(
      [{ failure_cause: 'could-not-start' }, { failure_cause: 'jev-could-not-choose' }]
    )
  })
})
