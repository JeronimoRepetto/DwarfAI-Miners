// The Host's maintenance tick (09 §7.1; #1290): "All sweeps run in the Host's maintenance tick (at boot after `ready`,
// then every 6 hours), each in its own short `BEGIN IMMEDIATE`, bounded to 1 000 rows per statement". Each sweep owns
// its transactions and its batch bound (askSweep.ts); the tick only decides when they run. host/main.ts starts it once
// the Host answered `ready`, and the clean exit stops it with the module routes.
//
// - A sweep that throws is logged `failed` with its error code and never stops the others or the next tick: retention
//   waits six hours, nothing else depends on it. A sweep that deleted rows logs its count (ids and numbers only,
//   ADR-026).
// - `hostMaintenanceSweeps` is the list host/main.ts hands the tick: the closed-asks sweep (09 §7.1 row `asks`,
//   `ask_answers`; ADR-010, PO #91). A newer database file, which the Host opens read-only and never writes (ADR-005
//   item 5; hostDatabase.ts), is never swept.
//
// Package gap (#1290, recorded in the hand-off): 09 §7.1 names the tick but no issue builds it; the other sweeps of
// that table join this list with the issues that wire them (the attention keys' `sweep`, 09 §7.1 row
// `attention_keys`, is not wired yet).
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { Scheduler } from '../kernel/ports/scheduler'
import type { SqliteDatabase } from '../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../kernel/ports/transactionRunner'
import { sweepClosedAsks } from '../modules/asking/adapters/askSweep'
import { errorCode } from './boot'

/** 09 §7.1: the maintenance tick runs every 6 hours. */
export const MAINTENANCE_EVERY_MS = 6 * 60 * 60 * 1000

const EVENT = 'maintenance.sweep'

export interface MaintenanceSweep {
  /** The module that owns the swept rows (the log record's `subsystem`). */
  subsystem: string
  /** Runs the sweep in its own transactions; returns how many rows it deleted. */
  run(): number
}

export interface MaintenanceTickDeps {
  scheduler: Scheduler
  log: DiagnosticsLog
  sweeps: readonly MaintenanceSweep[]
}

/** Runs every sweep now, then every `MAINTENANCE_EVERY_MS` until `stop`. */
export function startMaintenanceTick(deps: MaintenanceTickDeps): { stop(): void } {
  let next: { cancel(): void } | null = null
  let stopped = false

  const sweepOnce = (sweep: MaintenanceSweep): void => {
    try {
      const count = sweep.run()
      if (count > 0) {
        deps.log.record({
          level: 'info',
          event: EVENT,
          subsystem: sweep.subsystem,
          outcome: 'ok',
          count
        })
      }
    } catch (error) {
      deps.log.record({
        level: 'error',
        event: EVENT,
        subsystem: sweep.subsystem,
        outcome: 'failed',
        errCode: errorCode(error)
      })
    }
  }

  const tick = (): void => {
    next = null
    if (stopped) return
    for (const sweep of deps.sweeps) sweepOnce(sweep)
    next = deps.scheduler.after(MAINTENANCE_EVERY_MS, tick)
  }

  tick()
  return {
    stop: () => {
      stopped = true
      next?.cancel()
      next = null
    }
  }
}

export interface HostMaintenanceDeps {
  /** The Host's one writer (09 §8.1), opened by boot step 2. */
  db: SqliteDatabase
  transactions: TransactionRunner
  clock: Clock
  /** The file is newer than this build and was opened read-only (`db-read-only`, ADR-005 item 5). */
  readOnly: boolean
}

/** The sweeps of 09 §7.1 the Host runs; none on a read-only file. */
export function hostMaintenanceSweeps(deps: HostMaintenanceDeps): MaintenanceSweep[] {
  if (deps.readOnly) return []
  const { db, transactions, clock } = deps
  return [{ subsystem: 'asking', run: () => sweepClosedAsks({ db, transactions, clock }) }]
}
