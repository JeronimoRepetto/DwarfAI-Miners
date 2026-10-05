// layer: L2
// L2 (17 §1.2): `LedgerCommands.runCoalBackfill` (16 §4.10; 09 §5.5; 07 machine 19) over
// `FakeHistoricalUsageScanner`, `InMemoryLedgerRepository` and `FakeClock`. The bus refuses a
// publish inside a transaction (16 §2.3), so every event seen here was published after a commit.
import { describe, expect, it } from 'vitest'
import type { Instant, MineId } from '../../../kernel/domain/values'
import { stepCoalBackfill, type CoalBackfillState } from '../domain/coalBackfill'
import type { FakeHistoryUnit } from '../ports/fakes/FakeHistoricalUsageScanner'
import type {
  HistoricalUsage,
  HistoricalUsageRecord,
  HistoricalUsageScanner,
  ScanBudget
} from '../ports/historicalUsageScanner'
import type { LedgerRepository } from '../ports/ledgerRepository'
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

/** `count` Codex days of 400 files each, with no usage before the moment. */
function busyDays(count: number): FakeHistoryUnit[] {
  return Array.from({ length: count }, (_, i) =>
    unit(`codex:/history/2025/12/0${i + 1}`, [], { adapterId: 'codex', files: 400 })
  )
}

describe('runCoalBackfill', () => {
  it('[S19.02] the backfill starts only when the Host is ready and no reset saga is running', async () => {
    const w = world()
    const mine = w.addMine('gold')
    w.scanner.script([unit('claude:/history/a', [rec('msg-1', mine, 5_000)])])

    w.setResetInProgress(true)
    const blocked = await w.ledger.commands.runCoalBackfill(signal())
    expect(blocked).toMatchObject({ outcome: 'not-run', notRunReason: 'reset-in-progress' })
    expect(w.scanner.scans).toEqual([])
    expect(w.repository.backfillState().state).toBe('not-started')

    w.setResetInProgress(false)
    w.setInstallMoment(null)
    expect(await w.ledger.commands.runCoalBackfill(signal())).toMatchObject({
      outcome: 'not-run',
      notRunReason: 'no-install-moment'
    })
    expect(w.scanner.scans).toEqual([])

    w.setInstallMoment(INSTALL)
    const report = await w.ledger.commands.runCoalBackfill(signal())
    expect(report).toMatchObject({
      outcome: 'done',
      scanUnits: 1,
      unitsCredited: 1,
      tokensCredited: 5_000
    })
    expect(w.scanner.scans.map((scan) => scan.before)).toEqual([INSTALL])
    expect(w.entries(mine)).toEqual([
      { unitKey: 'msg-1', material: 'coal', tokens: 5_000, units: 2, kind: 'coal-backfill' }
    ])
    expect(w.bus.ofType('MaterialCredited').map((e) => e.payload)).toEqual([
      {
        mineId: mine,
        material: 'coal',
        tokens: 5_000,
        units: 2,
        unitKey: 'msg-1',
        kind: 'coal-backfill'
      }
    ])
    expect(w.bus.ofType('LedgerTotalsChanged').map((e) => e.payload.totals.coal)).toEqual([
      { tokens: 5_000 }
    ])
  })

  it('[S19.03, FM-098] reaching the per-boot budget stops the scan paused with finished units committed', async () => {
    const w = world()
    const mine = w.addMine('silver')
    // 1 500 files in all (a unit reads at most 400), then one more unit.
    w.scanner.script([
      ...busyDays(3),
      unit('claude:/history/a', [rec('msg-a', mine, 3_000)], { files: 300 }),
      unit('claude:/history/b', [rec('msg-b', mine, 4_000)])
    ])

    const report = await w.ledger.commands.runCoalBackfill(signal())

    expect(report).toMatchObject({ outcome: 'paused', scanUnits: 4, tokensCredited: 3_000 })
    expect(w.repository.backfillState()).toEqual({
      state: 'paused',
      creditedScanUnits: ['claude:/history/a', ...busyDays(3).map((u) => u.scanUnit)]
    })
    expect(w.ledger.queries.totals(mine).coal).toEqual({ tokens: 3_000 })
    expect(w.bus.ofType('CoalBackfillFinished')).toEqual([])
    expect(w.log.byEvent('ledger.backfill').at(-1)).toMatchObject({ causeClass: 'paused' })
  })

  it('[S19.07, FM-022] after a crash mid-run the next run skips recorded scan units and pays nothing twice', async () => {
    const w = world()
    const mine = w.addMine('copper')
    w.scanner.script([
      unit('claude:/history/a', [rec('msg-a', mine, 3_000)]),
      unit('claude:/history/b', [rec('msg-b1', mine, 4_000), rec('msg-b2', mine, 1_000)])
    ])
    // The Host dies while it records the second unit: its transaction never commits.
    const crashing = crashOnMark(w.repository, 'claude:/history/b')
    const crashed = inMemoryLedger(w.clock, {
      storage: w,
      repository: crashing,
      scanner: w.scanner
    })

    await expect(crashed.ledger.commands.runCoalBackfill(signal())).rejects.toThrow('host died')
    expect(w.repository.backfillState()).toEqual({
      state: 'running',
      creditedScanUnits: ['claude:/history/a']
    })
    // Credits and their scan-unit row commit together: nothing of the second unit was kept.
    expect(w.entries(mine).map((e) => e.unitKey)).toEqual(['msg-a'])

    const report = await w.ledger.commands.runCoalBackfill(signal())

    expect(w.scanner.scans.at(-1)?.budget.finishedScanUnits).toEqual(new Set(['claude:/history/a']))
    expect(report).toMatchObject({
      outcome: 'done',
      scanUnits: 1,
      unitsCredited: 2,
      tokensCredited: 5_000
    })
    expect(
      w
        .entries(mine)
        .map((e) => e.unitKey)
        .sort()
    ).toEqual(['msg-a', 'msg-b1', 'msg-b2'])
    expect(w.ledger.queries.totals(mine).coal).toEqual({ tokens: 8_000 })
    const credited = w.bus.ofType('MaterialCredited').map((e) => e.payload.unitKey)
    expect(credited.sort()).toEqual(['msg-a', 'msg-b1', 'msg-b2'])
  })

  it('[S19.08] an unreadable scan unit is skipped, logged without content, and the scan continues', async () => {
    const w = world()
    const mine = w.addMine('bronze')
    w.scanner.script([
      unit('codex:/history/2026/01/02', [], { adapterId: 'codex', unreadable: 'read-failed' }),
      unit('claude:/history/b', [rec('msg-b', mine, 4_000)])
    ])

    const report = await w.ledger.commands.runCoalBackfill(signal())

    expect(report).toMatchObject({ unreadableUnits: 1, scanUnits: 1, tokensCredited: 4_000 })
    expect(w.repository.backfillState().creditedScanUnits).toEqual(['claude:/history/b'])
    expect(w.log.byEvent('ledger.unit-skipped')).toEqual([
      expect.objectContaining({
        level: 'warn',
        subsystem: 'ledger',
        provider: 'codex',
        errCode: 'read-failed'
      })
    ])
    expect(JSON.stringify([...w.log.entries, ...w.log.refused])).not.toContain('/history/')

    // Skipped for this run only: the next run reads it again, and the scan then completes.
    expect(w.repository.backfillState().state).toBe('paused')
    w.scanner.script([
      unit('codex:/history/2026/01/02', [rec('coal:thread-1', mine, 9_000, { span: 'lifetime' })], {
        adapterId: 'codex'
      }),
      unit('claude:/history/b', [rec('msg-b', mine, 4_000)])
    ])
    expect(await w.ledger.commands.runCoalBackfill(signal())).toMatchObject({
      outcome: 'done',
      tokensCredited: 9_000
    })
    expect(w.ledger.queries.totals(mine).coal).toEqual({ tokens: 13_000 })
  })

  it('[S19.06] a Reset metrics aborts a running scan and a new install moment restarts it from not-started', async () => {
    const w = world()
    const mine = w.addMine('gold')
    const controller = new AbortController()
    const first = unit('claude:/history/a', [rec('msg-a', mine, 3_000)])
    const second = unit('claude:/history/b', [rec('msg-b', mine, 4_000)])
    // The Reset's `db` step deletes the install moment between two units, then aborts the scan.
    const scanner = scripted([first, second], (index) => {
      if (index === 1) {
        w.setInstallMoment(null)
        controller.abort()
      }
    })
    const reset = inMemoryLedger(w.clock, { storage: w, scanner })

    const report = await reset.ledger.commands.runCoalBackfill(controller.signal)

    expect(report).toMatchObject({ outcome: 'aborted', scanUnits: 1 })
    expect(w.entries(mine).map((e) => e.unitKey)).toEqual(['msg-a'])
    expect(reset.bus.ofType('CoalBackfillFinished')).toEqual([])

    // The saga's last step writes a new moment: the backfill is not-started with empty progress.
    const NEW_MOMENT = INSTALL + 86_400_000
    w.setInstallMoment(NEW_MOMENT)
    expect(w.repository.backfillState()).toEqual({ state: 'not-started', creditedScanUnits: [] })

    // A moment replaced under a run without its signal never takes a unit scanned for the old one.
    const replaced = inMemoryLedger(w.clock, {
      storage: w,
      scanner: scripted([second], () => w.setInstallMoment(NEW_MOMENT + 1))
    })
    expect(await replaced.ledger.commands.runCoalBackfill(signal())).toMatchObject({
      outcome: 'aborted',
      scanUnits: 0
    })
    expect(w.entries(mine).map((e) => e.unitKey)).toEqual(['msg-a'])

    w.setInstallMoment(NEW_MOMENT)
    w.scanner.script([second])
    expect(await w.ledger.commands.runCoalBackfill(signal())).toMatchObject({ outcome: 'done' })
    expect(w.scanner.scans.at(-1)?.before).toBe(NEW_MOMENT)
    expect(w.scanner.scans.at(-1)?.budget.finishedScanUnits).toEqual(new Set())
  })

  it('[ADR-006] a unit already credited live is never credited again as coal', async () => {
    const w = world()
    const mine = w.addMine('uranium')
    const dwarf = w.addDwarf(mine, 'transcript')
    expect(
      w.ledger.commands.creditUsage(
        {
          sourceKey: 'claude:claude:session-1:row-1',
          unitKey: 'msg-shared',
          dwarfId: dwarf,
          fidelity: 1,
          tokens: { inputNet: 6_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          sealed: true,
          providerTime: INSTALL + 1_000,
          observedAt: INSTALL + 1_100
        },
        'transcript'
      )
    ).toBe('credited')
    w.scanner.script([unit('claude:/history/a', [rec('msg-shared', mine, 6_000)])])

    const report = await w.ledger.commands.runCoalBackfill(signal())

    expect(report).toMatchObject({ outcome: 'done', unitsCredited: 0, tokensCredited: 0 })
    expect(w.entries(mine)).toEqual([
      { unitKey: 'msg-shared', material: 'uranium', tokens: 6_000, units: 0, kind: 'live' }
    ])
    expect(w.ledger.queries.totals(mine).coal).toEqual({ tokens: 0 })
    expect(w.bus.ofType('MaterialCredited').map((e) => e.payload.kind)).toEqual(['live'])
  })

  it('[S19.01, S19.04, S19.05] every machine 19 transition reaches its target: a written install moment makes the backfill not-started with empty progress, the next ready with the saga done resumes a paused scan skipping recorded units, and a complete scan is done with CoalBackfillFinished once; a transition 07 does not list is rejected', async () => {
    const w = world()
    const mine = w.addMine('gold')
    // S19.01
    expect(w.repository.backfillState()).toEqual({ state: 'not-started', creditedScanUnits: [] })

    w.scanner.script([
      ...busyDays(3),
      unit('claude:/history/a', [rec('msg-a', mine, 2_500)], { files: 300 }),
      unit('claude:/history/b', [rec('msg-b', mine, 5_000)])
    ])
    // S19.02 then S19.03
    expect((await w.ledger.commands.runCoalBackfill(signal())).outcome).toBe('paused')
    // S19.04 then S19.05
    w.clock.advance(1_000)
    const report = await w.ledger.commands.runCoalBackfill(signal())
    expect(report).toMatchObject({ outcome: 'done', scanUnits: 1, tokensCredited: 5_000 })
    const firstRun = ['claude:/history/a', ...busyDays(3).map((u) => u.scanUnit)]
    expect(w.scanner.scans[1]?.budget.finishedScanUnits).toEqual(new Set(firstRun))
    expect(w.repository.backfillState()).toEqual({
      state: 'done',
      creditedScanUnits: [...firstRun, 'claude:/history/b'].sort(),
      doneAt: w.clock.now()
    })
    expect(w.bus.ofType('CoalBackfillFinished').map((e) => e.payload.report)).toEqual([report])

    // Done stays done: another ready scans nothing and announces nothing again.
    expect(await w.ledger.commands.runCoalBackfill(signal())).toMatchObject({
      outcome: 'not-run',
      notRunReason: 'already-done'
    })
    expect(w.scanner.scans).toHaveLength(2)
    expect(w.bus.ofType('CoalBackfillFinished')).toHaveLength(1)

    // Every listed transition reaches its target; the guard and unlisted pairs are rejected.
    const listed: Array<
      [CoalBackfillState | null, Parameters<typeof stepCoalBackfill>[1], string, CoalBackfillState]
    > = [
      [null, { type: 'moment-written' }, 'S19.01', 'not-started'],
      ['done', { type: 'moment-written' }, 'S19.01', 'not-started'],
      ['not-started', { type: 'ready', resetSagaDone: true }, 'S19.02', 'running'],
      ['running', { type: 'budget-reached' }, 'S19.03', 'paused'],
      ['paused', { type: 'ready', resetSagaDone: true }, 'S19.04', 'running'],
      ['running', { type: 'complete' }, 'S19.05', 'done'],
      ['running', { type: 'reset' }, 'S19.06', 'not-started'],
      ['paused', { type: 'reset' }, 'S19.06', 'not-started'],
      ['running', { type: 'ready', resetSagaDone: true }, 'S19.07', 'running'],
      ['running', { type: 'unit-unreadable' }, 'S19.08', 'running']
    ]
    for (const [from, event, id, to] of listed) {
      expect(stepCoalBackfill(from, event), `${String(from)} ${event.type}`).toEqual({
        ok: true,
        id,
        to
      })
    }
    expect(stepCoalBackfill('not-started', { type: 'ready', resetSagaDone: false })).toEqual({
      ok: false,
      reason: 'guard'
    })
    for (const [from, event] of [
      ['done', { type: 'ready', resetSagaDone: true }],
      ['not-started', { type: 'complete' }],
      ['paused', { type: 'budget-reached' }],
      ['running', { type: 'moment-written' }],
      ['done', { type: 'reset' }],
      [null, { type: 'ready', resetSagaDone: true }]
    ] as const) {
      expect(stepCoalBackfill(from, event), `${String(from)} ${event.type}`).toEqual({
        ok: false,
        reason: 'not-listed'
      })
    }
  })
})

/** The repository with a `markScanUnit` that kills the Host once, for `scanUnit`. */
function crashOnMark(repository: LedgerRepository, scanUnit: string): LedgerRepository {
  let crashed = false
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === 'markScanUnit') {
        return (unit: { scanUnit: string }, at: Instant) => {
          if (!crashed && unit.scanUnit === scanUnit) {
            crashed = true
            throw new Error('host died')
          }
          return target.markScanUnit(unit as Parameters<LedgerRepository['markScanUnit']>[0], at)
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** A scanner that yields `units` in order and runs `before(index)` before yielding each one. */
function scripted(
  units: FakeHistoryUnit[],
  before: (index: number) => void
): HistoricalUsageScanner {
  return {
    async *scan(
      _at: Instant,
      _budget: ScanBudget,
      _signal: AbortSignal
    ): AsyncIterable<HistoricalUsage> {
      for (const [index, item] of units.entries()) {
        await Promise.resolve()
        before(index)
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
