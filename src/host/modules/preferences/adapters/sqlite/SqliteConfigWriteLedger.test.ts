import { describe, expect, it } from 'vitest'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import type { ConfigWriteRow } from '../external-config/configWriteLedger'
import { SqliteConfigWriteLedger } from './SqliteConfigWriteLedger'

// L3 (17 §1.3) over a copy of the template database: the real CHECKs and the partial unique index
// `config_writes_one_active` of 09 §4.8 judge every row.
function subject() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  return { db, ledger: new SqliteConfigWriteLedger({ db }), tx: runner }
}

const ROW: ConfigWriteRow = {
  id: '00000000-0000-7000-8000-000000000001',
  kind: 'opencode-plugin',
  targetPath: '/home/j/.config/opencode/plugin/dwarfai.js',
  ownedMarker: '// dwarfai-managed',
  backupPath: null,
  consentOrigin: 'add-panel',
  writtenAt: 1_000,
  verifiedAt: null,
  revertedAt: null
}

describe('SqliteConfigWriteLedger', () => {
  it('[ADR-016, S14.02] a recorded write is the live one until verified, then stays live with its backup', () => {
    const { ledger, tx } = subject()

    tx.inTransaction(() => ledger.record(ROW))
    expect(ledger.active('opencode-plugin', ROW.targetPath)).toStrictEqual(ROW)
    expect(ledger.unverified()).toStrictEqual([ROW])
    expect(ledger.active('claude-hooks', ROW.targetPath)).toBeNull()

    tx.inTransaction(() => ledger.markVerified(ROW.id, 2_000, `${ROW.targetPath}.dwarfai-bak-x`))
    expect(ledger.active('opencode-plugin', ROW.targetPath)).toStrictEqual({
      ...ROW,
      verifiedAt: 2_000,
      backupPath: `${ROW.targetPath}.dwarfai-bak-x`
    })
    expect(ledger.unverified()).toStrictEqual([])
  })

  it('[S14.06] a reverted write keeps its row with reverted_at and is no longer live', () => {
    const { db, ledger, tx } = subject()
    tx.inTransaction(() => ledger.record(ROW))

    tx.inTransaction(() => ledger.markReverted(ROW.id, 3_000))

    expect(ledger.active('opencode-plugin', ROW.targetPath)).toBeNull()
    expect(ledger.unverified()).toStrictEqual([])
    expect(db.all('SELECT reverted_at FROM config_writes WHERE id = ?', [ROW.id])).toEqual([
      { reverted_at: 3_000 }
    ])
  })

  it('[S14.04] a removed Tx A row is gone, and recording again replaces a row by its id', () => {
    const { db, ledger, tx } = subject()
    tx.inTransaction(() => ledger.record(ROW))

    tx.inTransaction(() => ledger.record({ ...ROW, consentOrigin: 'settings', writtenAt: 1_500 }))
    expect(ledger.active('opencode-plugin', ROW.targetPath)).toMatchObject({
      consentOrigin: 'settings',
      writtenAt: 1_500
    })

    tx.inTransaction(() => ledger.remove(ROW.id))
    expect(db.all('SELECT count(*) AS n FROM config_writes')).toEqual([{ n: 0 }])
  })

  it('[ADR-016] at most one live write per target: a second live row is refused by the schema', () => {
    const { ledger, tx } = subject()
    tx.inTransaction(() => ledger.record(ROW))

    expect(() =>
      tx.inTransaction(() => ledger.record({ ...ROW, id: '00000000-0000-7000-8000-000000000002' }))
    ).toThrow()
  })
})
