// `LedgerCommands.runCoalBackfill(signal)` (16 §4.10; 09 §5.5; 07 machine 19; UC-007 "Coal
// backfill"; 11 F10): everything a person did with their providers before the install moment
// becomes coal of the right mines, once.
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
import type { Instant } from '../../../kernel/domain/values'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import { isCoal } from '../domain/coalBoundary'
import {
  stepCoalBackfill,
  type BackfillReport,
  type CoalBackfillEvent,
  type CoalBackfillState
} from '../domain/coalBackfill'
import type { HistoricalUsage, HistoricalUsageScanner } from '../ports/historicalUsageScanner'
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
      deps.log.record({
        level: 'warn',
        event: 'ledger.unit-skipped',
        subsystem: SUBSYSTEM,
        outcome: 'skipped',
        provider: item.adapterId,
        errCode: item.errCode
      })
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
      let units = 0
      let tokens = 0
      for (const record of item.records) {
        if (!isCoal(record, at)) continue
        if (crediting.creditCoal(record)) {
          units += 1
          tokens += record.tokens
        }
      }
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
