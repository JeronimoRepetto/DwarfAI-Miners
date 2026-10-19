// layer: L5
// L5 (17 §1.5): the coal backfill on a copy of the template database (schema v1, migration 1):
// a unit's `coal-backfill` credits and its `coal_backfill_units` row commit in one transaction
// (09 §5.5; FM-022), the coal CHECK pairs them (INV-95) and the `install_moment` CHECK keeps
// `backfill_done_at` set exactly when the backfill is `done`.
import { describe, expect, it } from 'vitest'
import type { Instant, MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { SqliteTransactionRunner } from '../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../platform/sqlite/testing/templateDb'
import type { LedgerEvent } from '../domain/events'
import { createLedger } from '../index'
import { FakeHistoricalUsageScanner } from '../ports/fakes/FakeHistoricalUsageScanner'
import type { LedgerRepository, ScanUnitKey } from '../ports/ledgerRepository'
import { sqliteLedgerSeeds } from '../testing/sqliteLedgerSeeds'
import { SqliteLedgerRepository } from './SqliteLedgerRepository'

const INSTALL = 1_760_000_000_000

function backfillDb() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  const seeds = sqliteLedgerSeeds(db, runner)
  seeds.setInstallMoment(INSTALL)
  const clock = new FakeClock(INSTALL + 5_000)
  const repository = new SqliteLedgerRepository({
    db,
    scope: runner,
    ids: new SequenceIdGenerator(),
    clock
  })
  const scanner = new FakeHistoricalUsageScanner()
  const ledgerOver = (store: LedgerRepository) =>
    createLedger({
      repository: store,
      transactions: runner,
      scope: runner,
      bus: new RecordingEventBus<LedgerEvent>({ transactionScope: runner }),
      clock,
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-0077',
      scanner,
      log: new RecordingDiagnosticsLog()
    })
  return { db, seeds, clock, repository, scanner, ledgerOver }
}

function record(unitKey: string, mineId: MineId, tokens: number) {
  return { unitKey, span: 'unit' as const, mineId, tokens, providerTime: INSTALL - 1 }
}

describe('coal backfill schema', () => {
  it('[INV-95] a coal-backfill credit and its scan-unit row commit together and the backfill state CHECK holds', async () => {
    const t = backfillDb()
    const mine = t.seeds.addMine('gold')
    t.scanner.script([
      {
        scanUnit: 'claude:/history/a',
        adapterId: 'claude',
        files: 1,
        records: [record('msg-a1', mine, 2_000), record('msg-a2', mine, 3_000)]
      },
      {
        scanUnit: 'codex:/history/2026/01/02',
        adapterId: 'codex',
        files: 1,
        records: [record('coal:thread-1', mine, 7_500)]
      }
    ])
    // The Host dies while it records the second unit.
    let crashed = false
    const crashing = new Proxy(t.repository, {
      get(target, property, receiver) {
        if (property === 'markScanUnit') {
          return (unit: ScanUnitKey, at: Instant) => {
            if (!crashed && unit.adapterId === 'codex') {
              crashed = true
              throw new Error('host died')
            }
            return target.markScanUnit(unit, at)
          }
        }
        const value: unknown = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })

    await expect(
      t.ledgerOver(crashing).commands.runCoalBackfill(new AbortController().signal)
    ).rejects.toThrow('host died')

    const entries = () =>
      t.db
        .all('SELECT unit_key, material, tokens, units, kind FROM ledger_entries ORDER BY unit_key')
        .map((row) => ({ ...row }))
    const scanUnits = () =>
      t.db
        .all(
          'SELECT scan_unit, install_moment_id, adapter_id, tokens_credited, credited_at FROM coal_backfill_units ORDER BY scan_unit'
        )
        .map((row) => ({ ...row }))
    const coalTotal = () =>
      Number(
        t.db.all("SELECT tokens FROM material_totals WHERE mine_id = ? AND material = 'coal'", [
          mine
        ])[0]?.['tokens'] ?? 0
      )
    const moment = () => ({
      ...t.db.all('SELECT backfill_state, backfill_done_at FROM install_moment')[0]
    })

    expect(entries()).toEqual([
      { unit_key: 'msg-a1', material: 'coal', tokens: 2_000, units: 0, kind: 'coal-backfill' },
      { unit_key: 'msg-a2', material: 'coal', tokens: 3_000, units: 1, kind: 'coal-backfill' }
    ])
    expect(scanUnits()).toEqual([
      {
        scan_unit: 'claude:/history/a',
        install_moment_id: 1,
        adapter_id: 'claude',
        tokens_credited: 5_000,
        credited_at: INSTALL + 5_000
      }
    ])
    expect(coalTotal()).toBe(5_000)
    expect(moment()).toEqual({ backfill_state: 'running', backfill_done_at: null })

    t.clock.advance(2_000)
    const report = await t
      .ledgerOver(t.repository)
      .commands.runCoalBackfill(new AbortController().signal)

    expect(report).toMatchObject({ outcome: 'done', scanUnits: 1, tokensCredited: 7_500 })
    expect(entries().map((e) => e['unit_key'])).toEqual(['coal:thread-1', 'msg-a1', 'msg-a2'])
    expect(scanUnits().map((u) => [u['scan_unit'], u['tokens_credited']])).toEqual([
      ['claude:/history/a', 5_000],
      ['codex:/history/2026/01/02', 7_500]
    ])
    expect(coalTotal()).toBe(12_500)
    expect(moment()).toEqual({ backfill_state: 'done', backfill_done_at: INSTALL + 7_000 })

    // The database backstops: done exactly with its instant; coal only through the backfill.
    expect(() =>
      t.db.run("UPDATE install_moment SET backfill_state = 'paused' WHERE id = 1")
    ).toThrow(/CHECK/)
    expect(() =>
      t.db.run('UPDATE install_moment SET backfill_done_at = NULL WHERE id = 1')
    ).toThrow(/CHECK/)
    expect(() =>
      t.db.run(
        `INSERT INTO ledger_entries (id, unit_key, mine_id, material, tokens, units, kind, credited_at)
         VALUES ('00000000-0000-7000-8000-0000000077e1', 'msg-live', ?, 'coal', 1, 0, 'live', 0)`,
        [mine]
      )
    ).toThrow(/CHECK/)
    expect(moment()).toEqual({ backfill_state: 'done', backfill_done_at: INSTALL + 7_000 })

    // A new install moment takes its progress with it (cascade): the backfill starts again.
    t.seeds.setInstallMoment(INSTALL + 86_400_000)
    expect(scanUnits()).toEqual([])
    expect(moment()).toEqual({ backfill_state: 'not-started', backfill_done_at: null })
  })
})
