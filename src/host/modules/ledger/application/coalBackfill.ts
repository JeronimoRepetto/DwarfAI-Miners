// `LedgerCommands.runCoalBackfill(signal)` (16 §4.10; 09 §5.5; 07 machine 19; UC-007 "Coal
// backfill"; 11 F10): everything a person did with their providers before the install moment
// becomes coal of the right mines, once. `runMineCoalBackfill` (below) pays the same history to a
// mine created later (11 O-11-10, owner ruling 2026-10-06), through the same crediting.
//
// - Gates (S19.02): an install moment exists and no reset saga is unfinished; the caller runs it at
//   Host `ready` (later: ISSUE-096). A `done` backfill does not run again until a new install
//   moment restarts it (S19.01). Otherwise the state becomes `running` (S19.02, S19.04, or S19.07
//   after a crash) and the scan reads history strictly before `install_moment.at`, skipping the
//   scan units already recorded for that moment.
// - One transaction per finished scan unit (FM-022): its coal credits (`kind = 'coal-backfill'`,
//   only for records the domain boundary calls coal, INV-95) and its `coal_backfill_units` row
//   commit together, so a Host that dies mid-unit leaves neither, and the next run reads the unit
//   again. A unit already credited (live, or by an earlier run) answers `duplicate` and pays
//   nothing twice (ADR-006 item 8). The unit's events are published after its commit.
// - The install moment is re-read in each unit's transaction: a Reset metrics that deleted or
//   rewrote it (S19.06) ends the run, `aborted`, without committing a unit scanned for the old
//   moment, as an aborted `signal` does. Nothing is written then: the new moment starts at
//   `not-started` (S19.01).
// - An unreadable unit (S19.08) is skipped and logged without content (`ledger.unit-skipped`,
//   19 §9; ADR-026 item 4) and the scan continues. Package gap: 07 says "skipped for this run" but
//   lists no transition that lets a later run read it; a run that skipped one ends `paused` (the
//   S19.03 transition), so the next Host `ready` reads it again. Otherwise one busy file at the
//   first boot (the OpenCode store is one unit) would lose its history for good.
// - The per-boot budget reached ends the run `paused` (S19.03); a complete scan with nothing
//   skipped ends it `done` with `backfill_done_at` and `CoalBackfillFinished` once (S19.05).
// - Progress is logged as `ledger.backfill` with the state in `causeClass` and the units of the
//   run in `count`. Package gap: 19 §9 gives the event `outcome` values (`running`, `paused`,
//   `done`) that ADR-026's `LogRecord.outcome` does not admit; the record keeps `outcome: 'ok'`.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { Instant, MineId } from '../../../kernel/domain/values'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import { isCoal } from '../domain/coalBoundary'
import {
  stepCoalBackfill,
  type BackfillReport,
  type CoalBackfillEvent,
  type CoalBackfillState
} from '../domain/coalBackfill'
import type {
  HistoricalUsage,
  HistoricalUsageRecord,
  HistoricalUsageScanner,
  ScanBudget
} from '../ports/historicalUsageScanner'
import type { Crediting } from './crediting'

/** The per-boot budget of 09 §5.5 (16 §2.6), transplanted from `coalBackfill.ts` at `0bfd108`. */
export const COAL_SCAN_BUDGET = Object.freeze({
  /** `DEFAULT_MAX_FILES`. */
  maxFiles: 1_500,
  /** `DEFAULT_MAX_DURATION_MS`. */
  maxDurationMs: 8_000,
  /** `DEFAULT_MAX_FILES_PER_DIR`. */
  maxFilesPerDir: 400
})

export interface CoalBackfillDeps {
  /** 16 §4.10 `HistoricalUsageScanner` (`ProviderHistoryScanner`, composed by `host/main.ts`). */
  scanner: HistoricalUsageScanner
  log: DiagnosticsLog
}

const SUBSYSTEM = 'ledger'

type Tally = Omit<BackfillReport, 'outcome' | 'notRunReason'>

/** Thrown inside a unit's transaction to roll it back; never leaves this module. */
class UnitRolledBack extends Error {
  constructor(readonly reason: 'moment-changed' | 'already-recorded') {
    super(reason)
  }
}

export async function runCoalBackfill(
  crediting: Crediting,
  deps: CoalBackfillDeps,
  signal: AbortSignal
): Promise<BackfillReport> {
  const store = crediting.repository
  const tally: Tally = { scanUnits: 0, unitsCredited: 0, tokensCredited: 0, unreadableUnits: 0 }
  const at = store.installMoment()
  if (at === null) return { outcome: 'not-run', notRunReason: 'no-install-moment', ...tally }
  if (store.resetInProgress()) {
    return { outcome: 'not-run', notRunReason: 'reset-in-progress', ...tally }
  }
  const progress = store.backfillState()
  if (progress.state === 'done') {
    return { outcome: 'not-run', notRunReason: 'already-done', ...tally }
  }
  const running = step(progress.state, { type: 'ready', resetSagaDone: true })
  crediting.run(() => store.setBackfillState({ state: running, creditedScanUnits: [] }))
  logProgress(deps.log, running, 0)

  const budget = { ...COAL_SCAN_BUDGET, finishedScanUnits: new Set(progress.creditedScanUnits) }
  let budgetReached = false
  for await (const item of deps.scanner.scan(at, budget, signal)) {
    if (signal.aborted) return aborted(tally)
    if (item.kind === 'budget-reached') {
      budgetReached = true
      break
    }
    if (item.kind === 'unreadable') {
      step(running, { type: 'unit-unreadable' })
      tally.unreadableUnits += 1
      logUnreadable(deps.log, item)
      continue
    }
    const committed = commitUnit(crediting, item, at)
    if (committed === 'moment-changed') return aborted(tally)
    if (committed === 'already-recorded') continue
    tally.scanUnits += 1
    tally.unitsCredited += committed.units
    tally.tokensCredited += committed.tokens
  }
  if (signal.aborted || store.installMoment() !== at) return aborted(tally)

  if (budgetReached || tally.unreadableUnits > 0) {
    const paused = step(running, { type: 'budget-reached' })
    crediting.run(() => store.setBackfillState({ state: paused, creditedScanUnits: [] }))
    logProgress(deps.log, paused, tally.scanUnits)
    return { outcome: 'paused', ...tally }
  }
  const done = step(running, { type: 'complete' })
  const report: BackfillReport = { outcome: 'done', ...tally }
  crediting.run(() => {
    store.setBackfillState({
      state: done,
      creditedScanUnits: [],
      doneAt: crediting.deps.clock.now()
    })
    crediting.announceFinished(report)
  })
  logProgress(deps.log, done, tally.scanUnits)
  return report
}

/**
 * `LedgerCommands.runMineCoalBackfill(mineId, signal)` (owner ruling on 11 O-11-10, 2026-10-06):
 * a folder that becomes a mine after the backfill ran has its pre-install usage credited as coal.
 *
 * - Gates: an install moment exists and no reset saga is unfinished (INV-97), as for the full
 *   backfill; machine 19's state is neither read nor written, so the run is the same whether the
 *   full backfill is `done`, `paused` or not started (a unit it already recorded may hold the new
 *   mine's history, read while the folder was no mine).
 * - The scan reads the whole history before the moment again, recorded scan units included, and
 *   credits only records whose folder resolves to `mineId` (the scanner's resolution: a removed
 *   mine's folder resolves to no mine, so it is paid nothing). Package gap: 16 §4.10's `scan` has
 *   no folder filter, and a scan unit's folders are known only once it is read (a Claude project
 *   directory name is never decoded), so "only that mine's folder" is a filter on the records.
 * - Same crediting as the full backfill, one transaction per unit: `creditCoal`, only for records
 *   the domain boundary calls coal (INV-95), keyed by the live `unitKey` or `coal:<streamId>`, so
 *   a unit any path already credited answers `duplicate` and pays nothing twice (ADR-006 item 8).
 *   No `coal_backfill_units` row is written: those rows are the full backfill's progress.
 * - Package gap: the per-boot budget (09 §5.5) bounds a boot; this run has no stored progress to
 *   resume from (no machine, no schema), so it is bounded per unit (`maxFilesPerDir`) only, and a
 *   budget stop would lose the rest of the mine's history for good. It ends `done`, or `aborted`
 *   by `signal` or by a Reset metrics that started or changed the moment mid-run (the unit read
 *   for the old moment is not committed). An unreadable unit is skipped, logged and counted
 *   (`unreadableUnits`); nothing reads it again for this mine.
 * - The report's `scanUnits` counts the units read, none of which is recorded.
 */
export async function runMineCoalBackfill(
  crediting: Crediting,
  deps: CoalBackfillDeps,
  mineId: MineId,
  signal: AbortSignal
): Promise<BackfillReport> {
  const store = crediting.repository
  const tally: Tally = { scanUnits: 0, unitsCredited: 0, tokensCredited: 0, unreadableUnits: 0 }
  const at = store.installMoment()
  if (at === null) return { outcome: 'not-run', notRunReason: 'no-install-moment', ...tally }
  if (store.resetInProgress()) {
    return { outcome: 'not-run', notRunReason: 'reset-in-progress', ...tally }
  }
  const budget: ScanBudget = {
    maxFiles: Number.POSITIVE_INFINITY,
    maxDurationMs: Number.POSITIVE_INFINITY,
    maxFilesPerDir: COAL_SCAN_BUDGET.maxFilesPerDir,
    finishedScanUnits: new Set()
  }
  for await (const item of deps.scanner.scan(at, budget, signal)) {
    if (signal.aborted) return aborted(tally)
    if (item.kind === 'budget-reached') break
    if (item.kind === 'unreadable') {
      tally.unreadableUnits += 1
      logUnreadable(deps.log, item)
      continue
    }
    const records = item.records.filter((record) => record.mineId === mineId)
    const committed = commitMineUnit(crediting, records, at)
    if (committed === 'moment-changed') return aborted(tally)
    tally.scanUnits += 1
    tally.unitsCredited += committed.units
    tally.tokensCredited += committed.tokens
  }
  if (signal.aborted) return aborted(tally)
  return { outcome: 'done', ...tally }
}

/** One read unit of the per-mine run: its coal credits in one transaction, nothing recorded. */
function commitMineUnit(
  crediting: Crediting,
  records: HistoricalUsageRecord[],
  at: Instant
): { units: number; tokens: number } | 'moment-changed' {
  const store = crediting.repository
  try {
    return crediting.run(() => {
      if (store.installMoment() !== at || store.resetInProgress()) {
        throw new UnitRolledBack('moment-changed')
      }
      return creditCoalRecords(crediting, records, at)
    })
  } catch (error) {
    if (error instanceof UnitRolledBack) return 'moment-changed'
    throw error
  }
}

/** The records the boundary calls coal, each credited once (ADR-006 item 8; INV-95). */
function creditCoalRecords(
  crediting: Crediting,
  records: readonly HistoricalUsageRecord[],
  at: Instant
): { units: number; tokens: number } {
  let units = 0
  let tokens = 0
  for (const record of records) {
    if (!isCoal(record, at)) continue
    if (crediting.creditCoal(record)) {
      units += 1
      tokens += record.tokens
    }
  }
  return { units, tokens }
}

/** One finished scan unit: its coal credits and its scan-unit row in one transaction. */
function commitUnit(
  crediting: Crediting,
  item: Extract<HistoricalUsage, { kind: 'scanned' }>,
  at: Instant
): { units: number; tokens: number } | UnitRolledBack['reason'] {
  const store = crediting.repository
  try {
    return crediting.run(() => {
      if (store.installMoment() !== at) throw new UnitRolledBack('moment-changed')
      const { units, tokens } = creditCoalRecords(crediting, item.records, at)
      const unit = { scanUnit: item.scanUnit, adapterId: item.adapterId, tokensCredited: tokens }
      if (store.markScanUnit(unit, crediting.deps.clock.now()) === 'duplicate') {
        throw new UnitRolledBack('already-recorded')
      }
      return { units, tokens }
    })
  } catch (error) {
    if (error instanceof UnitRolledBack) return error.reason
    throw error
  }
}

/** Machine 19's target for `event`; a transition 07 does not list is a defect here. */
function step(from: CoalBackfillState, event: CoalBackfillEvent): CoalBackfillState {
  const transition = stepCoalBackfill(from, event)
  if (!transition.ok) {
    throw new HostInvariantError(`coal backfill: ${event.type} from ${from} (${transition.reason})`)
  }
  return transition.to
}

function aborted(tally: Tally): BackfillReport {
  return { outcome: 'aborted', ...tally }
}

/** `ledger.unit-skipped`, without content or a path (19 §9; ADR-026 item 4). */
function logUnreadable(
  log: DiagnosticsLog,
  item: Extract<HistoricalUsage, { kind: 'unreadable' }>
): void {
  log.record({
    level: 'warn',
    event: 'ledger.unit-skipped',
    subsystem: SUBSYSTEM,
    outcome: 'skipped',
    provider: item.adapterId,
    errCode: item.errCode
  })
}

function logProgress(log: DiagnosticsLog, state: CoalBackfillState, count: number): void {
  log.record({
    level: 'info',
    event: 'ledger.backfill',
    subsystem: SUBSYSTEM,
    outcome: 'ok',
    causeClass: state,
    count
  })
}
