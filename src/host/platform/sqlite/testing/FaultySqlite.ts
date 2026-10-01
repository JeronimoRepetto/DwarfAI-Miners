// The fault-injecting `SqliteDatabase` (17 §1.10 CH-06, CH-07, CH-11; 13 FM-104…FM-106). Never
// imported by production code (R14).
//
// It is the real `NodeSqliteDatabase` over a real database file, so every fault goes through the
// adapter's own error mapping and logging, exactly as a driver failure would:
// - `fillDisk()` / `freeSpace()`: CH-06 through `PRAGMA max_page_count` pinned to the current size,
//   so any growth fails with a genuine `SQLITE_FULL` (SQLite documented behaviour); a real-OS
//   disk-full injector is UNVERIFIED (17 §8 O-17-03).
// - `failStatement(fault)`: the next statements matching `fault.match` fail with the given
//   `SQLITE_*` code, thrown as the driver's own error shape, either before the statement runs or
//   after it ran (the statement's side effects on disk exist, then the error surfaces).
// - `holdWriteLock()`: CH-07, a second connection holds the write lock until released.
// - `crashAfterCommit(n)`: CH-11, once the n-th `COMMIT` succeeded the "process" is gone: that
//   call and every later statement throw `SimulatedCrash`.
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteDatabase, type NodeSqliteOptions } from '../NodeSqliteDatabase'

/** Primary result codes of the faults this double injects (sqlite.org/rescode.html). */
const INJECTABLE = {
  SQLITE_BUSY: 5,
  SQLITE_IOERR: 10,
  SQLITE_CORRUPT: 11,
  SQLITE_FULL: 13
} as const

export type InjectableCode = keyof typeof INJECTABLE

export interface StatementFault {
  /** Which statements fail. */
  match: RegExp
  code: InjectableCode
  /** `before`: the statement never runs; `after`: it runs, then the error surfaces. */
  when: 'before' | 'after'
  /** How many matching statements fail; every one when omitted. */
  times?: number
}

/** The process "died" (CH-11): nothing after it runs. */
export class SimulatedCrash extends Error {
  constructor(commits: number) {
    super(`FaultySqlite: simulated crash after commit ${commits}`)
    this.name = 'SimulatedCrash'
  }
}

/** The error `node:sqlite` throws for a failed SQLite call. */
function driverError(code: InjectableCode): Error {
  return Object.assign(new Error(`FaultySqlite: injected ${code}`), {
    code: 'ERR_SQLITE_ERROR',
    errcode: INJECTABLE[code]
  })
}

/** SQLite's largest `max_page_count` (its default). */
const MAX_PAGE_COUNT = 4_294_967_294

export class FaultySqlite extends NodeSqliteDatabase {
  private faults: { fault: StatementFault; left: number }[] = []
  private crashAt: number | null = null
  private commits = 0
  private crashed = false

  /** A writer over the database file at `location`, with the 09 §8.1 policy. */
  static override open(location: string, options: NodeSqliteOptions = {}): FaultySqlite {
    return new FaultySqlite(location, 'wal', options)
  }

  /** CH-06: pin `max_page_count` to the current size; returns the pinned page count. */
  fillDisk(): number {
    const [row] = this.all('PRAGMA page_count')
    const pages = Number(Object.values(row ?? {})[0])
    this.exec(`PRAGMA max_page_count = ${pages}`)
    return pages
  }

  /** Undo `fillDisk()`. */
  freeSpace(): void {
    this.exec(`PRAGMA max_page_count = ${MAX_PAGE_COUNT}`)
  }

  failStatement(fault: StatementFault): void {
    this.faults.push({ fault, left: fault.times ?? Number.POSITIVE_INFINITY })
  }

  /** CH-07: a second connection takes the write lock (`BEGIN IMMEDIATE`) and keeps it. */
  holdWriteLock(): { release(): void } {
    const other = new DatabaseSync(this.location, { timeout: 0 })
    other.exec('BEGIN IMMEDIATE')
    return {
      release: () => {
        other.exec('ROLLBACK')
        other.close()
      }
    }
  }

  /** CH-11: the n-th successful `COMMIT` is the last thing that happens. */
  crashAfterCommit(n: number): void {
    this.crashAt = n
  }

  protected override intercept<T>(sql: string, execute: () => T): T {
    if (this.crashed) throw new SimulatedCrash(this.commits)
    const injected = this.takeFault(sql)
    if (injected?.when === 'before') throw driverError(injected.code)
    const result = execute()
    if (injected?.when === 'after') throw driverError(injected.code)
    if (/^\s*COMMIT\b/i.test(sql)) {
      this.commits += 1
      if (this.commits === this.crashAt) {
        this.crashed = true
        throw new SimulatedCrash(this.commits)
      }
    }
    return result
  }

  private takeFault(sql: string): StatementFault | null {
    const entry = this.faults.find(({ fault, left }) => left > 0 && fault.match.test(sql))
    if (entry === undefined) return null
    entry.left -= 1
    return entry.fault
  }
}
