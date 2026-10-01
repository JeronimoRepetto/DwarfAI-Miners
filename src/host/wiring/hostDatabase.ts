// The Host database at boot (16 §8.2 step 2; 09 §6.2, §8.4; ADR-005; ADR-015 item 4; ADR-002 D7):
// composition code that opens `<hostDataDir>/dwarfai.db` and keeps the Host epoch, built by the
// composition root and run by boot step 2 (bootSteps.ts).
//
// `open(context)`:
//   1. opens the file through the migration runner (ISSUE-034), reporting `migrating` when a
//      migration will run (07 S12.05). A refusal — a foreign or tampered file, a dev build on the
//      release data, a failed backup or quarantine — throws `HostDbRefusedError` with the refusal
//      as its code, which fails the boot (FM-008). A newer file opens read-only (ADR-005 item 5,
//      FM-100): the Host advertises `db-read-only` and writes nothing to it, so no epoch is kept
//      and no marker written;
//   2. reads the previous epoch BEFORE replacing it (09 §8.4 step 1), decides how it ended with
//      the current OS boot identity (step 2; ADR-015 item 4) and logs it (19 §9.1):
//      `host.boot.unclean` for a crash, `host.boot.rebooted` with the matched rule as its class
//      for a reboot, a logout or a marker `os-session-end`, and `outcome: degraded` when the boot
//      identity could not be told apart. The values themselves are never logged (09 §8.4);
//   3. writes the new epoch (this boot's `mintBootEpoch`, the one Host epoch value), its start
//      instant and the current boot identity with the marker cleared, in its own transaction
//      (step 3). At cut 0 there are no owned records to classify; the recovery step (EPIC-10,
//      ISSUE-173) moves this `beginEpoch` call into its classification transaction and reads the
//      decision through `previousEpochEnd()`.
//
// `checkpoint` is the ShutdownCheckpoint every clean exit runs (ISSUE-028): `flush` truncates the
// WAL, `markClean` writes the marker of the running epoch with its reason and truncates the WAL
// again, so the marker sits in the main file when the Host exits (09 §8.1, §8.4 step 4). Before
// the database is open, and on a read-only one, it does nothing.
import {
  BOOT_TIME_TOLERANCE_MS,
  decidePreviousEpochEnd,
  type PreviousEpochEnd
} from '../kernel/domain/bootIdentity'
import { HostInvariantError } from '../kernel/domain/errors'
import type { HostEpoch } from '../kernel/domain/values'
import type { Clock } from '../kernel/ports/clock'
import type { DiagnosticEntry, DiagnosticsLog } from '../kernel/ports/diagnosticsLog'
import type { ProcessControl } from '../kernel/ports/processControl'
import type { ShutdownCheckpoint } from '../kernel/ports/shutdownCheckpoint'
import type { SqliteDatabase } from '../kernel/ports/sqliteDatabase'
import { HostEpochLog, readResetEpoch } from '../platform/sqlite/hostEpochLog'
import {
  openHostDb,
  type HostDbRefusal,
  type OpenHostDbOptions
} from '../platform/sqlite/migrations/runner'
import { SqliteTransactionRunner } from '../platform/sqlite/SqliteTransactionRunner'
import type { BootStepContext } from './boot'

/** The Host database's file name in the hostDataDir (09 §1). */
export const HOST_DB_FILE = 'dwarfai.db'

export interface HostDatabaseDeps {
  /** `<hostDataDir>/dwarfai.db`. */
  path: string
  /** This boot's epoch (mintBootEpoch): what `hello.ok.epoch` carries is what `app_meta` keeps. */
  epoch: HostEpoch
  clock: Clock
  log: DiagnosticsLog
  /** The current OS boot identity (16 §3, AMENDMENT-3). */
  processControl: Pick<ProcessControl, 'currentBootIdentity'>
  /** The runner's build facts and migrations (`migrationsFor` over the boot's clock and ids). */
  open: Omit<OpenHostDbOptions, 'clock' | 'log' | 'onMigrating'>
}

export interface HostDatabase {
  /** Boot step 2: open, migrate, decide how the previous epoch ended, begin this one. */
  open(context: BootStepContext): Promise<void>
  /** The clean exit's checkpoint (ShutdownCheckpoint, ISSUE-028). */
  readonly checkpoint: ShutdownCheckpoint
  /** The bare `hello.ok.capabilities` conditions: `db-read-only` for a newer file. */
  capabilities(): readonly string[]
  /** How the previous epoch ended; null before step 2, on a first boot or a read-only file. */
  previousEpochEnd(): PreviousEpochEnd | null
  /** `app_meta.reset_epoch`, for the snapshot `meta` section (ISSUE-026). */
  resetEpoch(): number
  /** Closes the connection (a test's Host "killed"; production ends with its process). */
  close(): void
}

/** A refused open (09 §6.2): its code is the refusal, which the boot logs as `errCode`. */
export class HostDbRefusedError extends Error {
  constructor(readonly code: HostDbRefusal) {
    super(`the Host database was refused: ${code}`)
    this.name = 'HostDbRefusedError'
  }
}

const SUBSYSTEM = 'host'

type Opened =
  | { readOnly: false; db: SqliteDatabase; epochLog: HostEpochLog }
  | { readOnly: true; db: SqliteDatabase }

/** The 19 §9.1 records of a decision; the boot identity values are never part of them. */
function decisionEntries(decided: PreviousEpochEnd): Array<Omit<DiagnosticEntry, 'subsystem'>> {
  const entries: Array<Omit<DiagnosticEntry, 'subsystem'>> = []
  if (decided.degraded === true) {
    entries.push({
      level: 'info',
      event: 'host.boot.rebooted',
      outcome: 'degraded',
      msg: 'no OS boot identity could be read; a reboot cannot be told from a crash'
    })
  }
  if (decided.kind === 'crashed') {
    entries.push({
      level: 'warn',
      event: 'host.boot.unclean',
      msg: 'no clean-shutdown marker; recovery pass runs'
    })
  } else if (decided.rule !== 'none') {
    entries.push({
      level: 'info',
      event: 'host.boot.rebooted',
      causeClass: decided.rule,
      outcome: 'ok',
      msg: 'the previous Host epoch ended with the OS session'
    })
  }
  return entries
}

export function createHostDatabase(deps: HostDatabaseDeps): HostDatabase {
  let opened: Opened | null = null
  let decided: PreviousEpochEnd | null = null
  const record = (entry: Omit<DiagnosticEntry, 'subsystem'>): void =>
    deps.log.record({ ...entry, subsystem: SUBSYSTEM })

  const keepEpoch = async (db: SqliteDatabase): Promise<HostEpochLog> => {
    const transactions = new SqliteTransactionRunner(db)
    const epochLog = new HostEpochLog({ db, transactions })
    const current = await deps.processControl.currentBootIdentity()
    const previous = epochLog.readPrevious()
    if (previous !== null) {
      decided = decidePreviousEpochEnd(previous, current, { toleranceMs: BOOT_TIME_TOLERANCE_MS })
      for (const entry of decisionEntries(decided)) record(entry)
    }
    transactions.inTransaction(() =>
      epochLog.beginEpoch(transactions, {
        epoch: deps.epoch,
        startedAt: deps.clock.now(),
        bootIdentity: current
      })
    )
    return epochLog
  }

  return {
    async open(context) {
      const result = openHostDb(deps.path, {
        ...deps.open,
        clock: deps.clock,
        log: deps.log,
        onMigrating: () => context.reportMigrating()
      })
      if (!result.ok) throw new HostDbRefusedError(result.error)
      const { db } = result.value
      if (result.value.readOnly) {
        opened = { readOnly: true, db }
        return
      }
      try {
        opened = { readOnly: false, db, epochLog: await keepEpoch(db) }
      } catch (error) {
        db.close()
        throw error
      }
    },
    checkpoint: {
      flush: () => {
        if (opened?.readOnly === false) opened.epochLog.flush()
      },
      markClean: (reason) => {
        if (opened?.readOnly !== false) return
        opened.epochLog.markClean(reason, deps.clock.now())
        opened.epochLog.flush()
      }
    },
    capabilities: () => (opened?.readOnly === true ? ['db-read-only'] : []),
    previousEpochEnd: () => decided,
    resetEpoch: () => {
      if (opened === null) {
        throw new HostInvariantError('resetEpoch is read after boot step 2 opened the database')
      }
      return readResetEpoch(opened.db)
    },
    close: () => {
      opened?.db.close()
      opened = null
    }
  }
}
