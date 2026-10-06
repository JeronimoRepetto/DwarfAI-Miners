// layer: L2
// L2 (17 §1.2): `LedgerCommands.runMineCoalBackfill` (the owner's ruling on 11 O-11-10,
// 2026-10-06: a folder that becomes a mine after the coal backfill finished has its pre-install
// usage credited as coal; 09 §5.5; ADR-006 item 8; INV-95) over `FakeHistoricalUsageScanner`,
// `InMemoryLedgerRepository` and `FakeClock`. The bus refuses a publish inside a transaction
// (16 §2.3), so every event seen here was published after a commit.
import { describe, expect, it } from 'vitest'
import type { Instant, MineId } from '../../../kernel/domain/values'
import type { FakeHistoryUnit } from '../ports/fakes/FakeHistoricalUsageScanner'
import type {
  HistoricalUsage,
  HistoricalUsageRecord,
  HistoricalUsageScanner,
  ScanBudget
} from '../ports/historicalUsageScanner'
import { inMemoryLedger } from '../testing/inMemoryLedger'

const INSTALL = 1_760_000_000_000

function world(scanner?: HistoricalUsageScanner) {
  const w = inMemoryLedger(undefined, scanner === undefined ? {} : { scanner })
  w.setInstallMoment(INSTALL)
  return w
}

/** A per-unit record of `mineId` before the install moment. */
function rec(
  unitKey: string,
  mineId: MineId,
  tokens: number,
  overrides: Partial<HistoricalUsageRecord> = {}
): HistoricalUsageRecord {
  return { unitKey, span: 'unit', mineId, tokens, providerTime: INSTALL - 60_000, ...overrides }
}

function unit(
  scanUnit: string,
  records: HistoricalUsageRecord[],
  overrides: Partial<FakeHistoryUnit> = {}
): FakeHistoryUnit {
  return { scanUnit, adapterId: 'claude', files: 1, records, ...overrides }
}

const signal = () => new AbortController().signal

describe('runMineCoalBackfill', () => {
  it('[INV-95, ADR-006] a folder that becomes a mine after the backfill finished has its pre-install usage credited as coal, from every scan unit, to that mine only', async () => {
    const w = world()
    const gold = w.addMine('gold')
    // The full backfill runs while the later mine's folder is no mine: none of its records exist.
    w.scanner.script([
      unit('claude:/history/a', [rec('msg-gold', gold, 3_000)]),
      unit('codex:/history/2025/12/01', [], { adapterId: 'codex' })
    ])
    expect(await w.ledger.commands.runCoalBackfill(signal())).toMatchObject({ outcome: 'done' })
    const finished = w.repository.backfillState()

    // The folder becomes a mine: its records now resolve, in units the backfill already recorded.
    const silver = w.addMine('silver')
    w.scanner.script([
      unit('claude:/history/a', [rec('msg-gold', gold, 3_000), rec('msg-silver', silver, 5_000)]),
      unit(
        'codex:/history/2025/12/01',
        [rec('coal:thread-1', silver, 7_000, { span: 'lifetime' })],
        { adapterId: 'codex' }
      ),
      unit('claude:/history/b', [rec('msg-gold-2', gold, 9_000)])
    ])
    const credited = w.bus.ofType('MaterialCredited').length

    const report = await w.ledger.commands.runMineCoalBackfill(silver, signal())

    expect(report).toEqual({
      outcome: 'done',
      scanUnits: 3,
      unitsCredited: 2,
      tokensCredited: 12_000,
      unreadableUnits: 0
    })
    expect(w.entries(silver)).toEqual([
      { unitKey: 'msg-silver', material: 'coal', tokens: 5_000, units: 2, kind: 'coal-backfill' },
      { unitKey: 'coal:thread-1', material: 'coal', tokens: 7_000, units: 2, kind: 'coal-backfill' }
    ])
    // Only the new mine: another mine's history is the full backfill's, never this run's.
    expect(w.entries(gold).map((entry) => entry.unitKey)).toEqual(['msg-gold'])
    // The whole history is read again, recorded scan units included, from the same moment, and
    // the full backfill's progress is untouched.
    expect(w.scanner.scans.at(-1)).toMatchObject({ before: INSTALL })
    expect([...(w.scanner.scans.at(-1)?.budget.finishedScanUnits ?? [])]).toEqual([])
    expect(w.repository.backfillState()).toEqual(finished)
    expect(
      w.bus
        .ofType('MaterialCredited')
        .slice(credited)
        .map((e) => [e.payload.mineId, e.payload.unitKey, e.payload.kind])
    ).toEqual([
      [silver, 'msg-silver', 'coal-backfill'],
      [silver, 'coal:thread-1', 'coal-backfill']
    ])
    expect(w.bus.ofType('LedgerTotalsChanged').at(-1)?.payload).toMatchObject({
      mineId: silver,
      totals: { coal: { tokens: 12_000 } }
    })
    expect(w.bus.ofType('CoalBackfillFinished')).toHaveLength(1)
  })

  it('[ADR-006] nothing is credited twice: a second run for the same mine, a unit the full backfill or live accounting already credited', async () => {
    const w = world()
    const copper = w.addMine('copper')
    w.scanner.script([
      unit('claude:/history/a', [rec('msg-1', copper, 4_000), rec('msg-2', copper, 2_000)])
    ])
    expect(await w.ledger.commands.runCoalBackfill(signal())).toMatchObject({
      outcome: 'done',
      unitsCredited: 2
    })

    // The folder's mine is created again by the route after the full backfill already paid it.
    w.scanner.script([
      unit('claude:/history/a', [rec('msg-1', copper, 4_000), rec('msg-2', copper, 2_000)]),
      unit('claude:/history/b', [rec('msg-3', copper, 1_000)])
    ])
    expect(await w.ledger.commands.runMineCoalBackfill(copper, signal())).toMatchObject({
      outcome: 'done',
      unitsCredited: 1,
      tokensCredited: 1_000
    })
    const events = w.bus.ofType('MaterialCredited').length
    expect(await w.ledger.commands.runMineCoalBackfill(copper, signal())).toMatchObject({
      outcome: 'done',
      unitsCredited: 0,
      tokensCredited: 0
    })

    expect(w.entries(copper).map((entry) => entry.unitKey)).toEqual(['msg-1', 'msg-2', 'msg-3'])
    expect(w.ledger.queries.totals(copper).coal).toEqual({ tokens: 7_000 })
    expect(w.bus.ofType('MaterialCredited')).toHaveLength(events)
  })

  it('[INV-95] usage at or after the install moment is never credited as coal, whatever the scanner yields', async () => {
    const mine = '00000000-0000-7000-8000-000000000001' as MineId
    const w = world(
      yielding([
        rec('msg-before', mine, 2_000),
        rec('msg-at', mine, 3_000, { providerTime: INSTALL }),
        rec('msg-after', mine, 4_000, { providerTime: INSTALL + 1 }),
        rec('coal:straddling', mine, 5_000, { span: 'lifetime', providerTime: INSTALL + 60_000 })
      ])
    )
    expect(w.addMine('bronze')).toBe(mine)

    const report = await w.ledger.commands.runMineCoalBackfill(mine, signal())

    expect(report).toMatchObject({ outcome: 'done', unitsCredited: 1, tokensCredited: 2_000 })
    expect(w.entries(mine).map((entry) => entry.unitKey)).toEqual(['msg-before'])
  })

  it('[INV-97] nothing runs or is credited while a reset saga is unfinished or no install moment exists, and a reset begun mid-run commits no further unit', async () => {
    const w = world()
    const uranium = w.addMine('uranium')
    w.scanner.script([unit('claude:/history/a', [rec('msg-1', uranium, 5_000)])])

    w.setResetInProgress(true)
    expect(await w.ledger.commands.runMineCoalBackfill(uranium, signal())).toMatchObject({
      outcome: 'not-run',
      notRunReason: 'reset-in-progress'
    })
    w.setResetInProgress(false)
    w.setInstallMoment(null)
    expect(await w.ledger.commands.runMineCoalBackfill(uranium, signal())).toMatchObject({
      outcome: 'not-run',
      notRunReason: 'no-install-moment'
    })
    expect(w.scanner.scans).toEqual([])
    expect(w.entries(uranium)).toEqual([])

    // A reset saga starts while the scan is between units: the next unit is not committed.
    w.setInstallMoment(INSTALL)
    const midRun = world(
      interrupted(
        [
          unit('claude:/history/a', [rec('msg-1', uranium, 5_000)]),
          unit('claude:/history/b', [rec('msg-2', uranium, 6_000)])
        ],
        () => midRun.setResetInProgress(true)
      )
    )
    const mine = midRun.addMine('uranium')
    expect(mine).toBe(uranium)
    const aborted = await midRun.ledger.commands.runMineCoalBackfill(uranium, signal())
    expect(aborted).toMatchObject({ outcome: 'aborted', unitsCredited: 1, tokensCredited: 5_000 })
    expect(midRun.entries(uranium).map((entry) => entry.unitKey)).toEqual(['msg-1'])
  })

  it('[FM-098] an unreadable scan unit is skipped, logged without content and counted, and the scan continues', async () => {
    const w = world()
    const unmeasured = w.addMine(null)
    w.scanner.script([
      unit('opencode:/store/opencode.db', [], { adapterId: 'opencode', unreadable: 'busy' }),
      unit('claude:/history/a', [rec('msg-1', unmeasured, 5_000)])
    ])

    const report = await w.ledger.commands.runMineCoalBackfill(unmeasured, signal())

    expect(report).toEqual({
      outcome: 'done',
      scanUnits: 1,
      unitsCredited: 1,
      tokensCredited: 5_000,
      unreadableUnits: 1
    })
    expect(w.log.byEvent('ledger.unit-skipped')).toEqual([
      expect.objectContaining({ provider: 'opencode', errCode: 'busy', outcome: 'skipped' })
    ])
  })

  it('[INV-95] an aborted run stops between units and credits nothing more', async () => {
    const w = world()
    const gold = w.addMine('gold')
    w.scanner.script([unit('claude:/history/a', [rec('msg-1', gold, 5_000)])])
    const controller = new AbortController()
    controller.abort()

    expect(await w.ledger.commands.runMineCoalBackfill(gold, controller.signal)).toMatchObject({
      outcome: 'aborted',
      unitsCredited: 0
    })
    expect(w.entries(gold)).toEqual([])
  })
})

/** A scanner that yields `records` as one unit, unfiltered (a defective adapter). */
function yielding(records: HistoricalUsageRecord[]): HistoricalUsageScanner {
  return {
    async *scan(
      _at: Instant,
      _budget: ScanBudget,
      _signal: AbortSignal
    ): AsyncIterable<HistoricalUsage> {
      await Promise.resolve()
      yield { kind: 'scanned', scanUnit: 'claude:/history/a', adapterId: 'claude', records }
    }
  }
}

/** A scanner that yields `units` in order and runs `between()` after the first one. */
function interrupted(units: FakeHistoryUnit[], between: () => void): HistoricalUsageScanner {
  return {
    async *scan(
      _at: Instant,
      _budget: ScanBudget,
      _signal: AbortSignal
    ): AsyncIterable<HistoricalUsage> {
      for (const [index, item] of units.entries()) {
        await Promise.resolve()
        if (index > 0) between()
        yield {
          kind: 'scanned',
          scanUnit: item.scanUnit,
          adapterId: item.adapterId,
          records: item.records
        }
      }
    }
  }
}
