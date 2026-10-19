// The UI logger (05 §3.13, §3.14 "the UI's own log segments (src/ui-main/diagnostics, rules from
// contracts/logging)"; ADR-026; 19 §2): Electron main's one way to the log. `record(entry)` fills the writer-owned
// fields (`ts`, `proc: 'ui'`, `pid`, `appVersion`), applies the UI record rules and the pure `toLogLine`
// (allowlist, redaction, truncation), folds identical records within 60 s (ADR-026 item 6) and appends through the
// UI's segment writer. It never throws into its caller: a refused or unwritable record is dropped and counted, and
// `log.dropped` is written at the next successful write (13 FM-108; 19 §9.6, §10). No network, no telemetry, no
// in-app way to open the log (ADR-026 items 7–8).
import { redactStack, toLogLine, type LogRecord } from '@dwarfai/contracts'
import { FsUiSegmentWriter } from './FsUiSegmentWriter'
import type { UiClock } from './ports/clock'
import type { LogFiles } from './ports/logFiles'
import { RecordFolder } from './recordFolder'
import { isAppVersion, uiRecordRefusal } from './uiRecordRules'

/** What a caller records: every `LogRecord` field except those the writer fills. */
export type UiLogEntry = Omit<LogRecord, 'ts' | 'proc' | 'pid' | 'appVersion'>

/** The logging entry point the rest of Electron main depends on. */
export interface UiLog {
  record(entry: UiLogEntry): void
}

/** The records a process writes: `info` and above by default, `debug` too with DWARFAI_LOG=debug. */
export type UiLogLevel = 'info' | 'debug'

/** 19 §6: `DWARFAI_LOG=debug` enables debug records; anything else keeps the default `info`. */
export function logLevelFromEnv(env: Readonly<Record<string, string | undefined>>): UiLogLevel {
  return env.DWARFAI_LOG === 'debug' ? 'debug' : 'info'
}

export interface UiLoggerDeps {
  readonly files: LogFiles
  /** `<userData>/logs/` (ADR-026 item 1), the folder the Host writes into too (ADR-002 D2). */
  readonly logDir: string
  readonly clock: UiClock
  /** The app's version, as the build stamps it (`LogRecord.appVersion`). */
  readonly appVersion: string
  readonly pid: number
  readonly level: UiLogLevel
  /** The app root that `stack` frames are made relative to (ADR-026 item 5); frames outside it are dropped. */
  readonly appRoot?: string
}

/** The log's own counters (19 §10 "Log: records written, dropped, segments pruned"). */
export interface UiLogCounters {
  readonly written: number
  readonly refused: number
  readonly failed: number
  readonly pruned: number
}

/** Why records were dropped; each cause is reported by its own `log.dropped` record (19 §9.6). */
type DropCause = 'write-failed' | 'sensitive' | 'field-not-allowed'

const SUBSYSTEM = 'diagnostics'

export class UiLogger implements UiLog {
  private readonly writer: FsUiSegmentWriter
  private readonly folder = new RecordFolder<UiLogEntry>()
  private readonly unreported = new Map<DropCause, number>()
  private tail: Promise<void> = Promise.resolve()
  private written = 0
  private refused = 0
  private failed = 0
  private pruned = 0

  constructor(private readonly deps: UiLoggerDeps) {
    // The writer fills appVersion into every line: a value that is not a build version is a composition defect,
    // refused before anything is written (ADR-026 item 3).
    if (!isAppVersion(deps.appVersion)) {
      throw new TypeError('UiLogger: appVersion is not a build version')
    }
    this.writer = new FsUiSegmentWriter({
      files: deps.files,
      dir: deps.logDir,
      onPruned: (run) => this.onPruned(run)
    })
  }

  record(entry: UiLogEntry): void {
    try {
      this.accept(entry)
    } catch {
      // A defect in a rule or an adapter never reaches the caller (13 FM-108).
      this.failed += 1
      this.drop('write-failed')
    }
  }

  /** Resolves when every record accepted so far has been written or dropped. Never rejects. */
  async flush(): Promise<void> {
    let seen: Promise<void> | undefined
    while (seen !== this.tail) {
      seen = this.tail
      await seen
    }
  }

  counters(): UiLogCounters {
    return {
      written: this.written,
      refused: this.refused,
      failed: this.failed,
      pruned: this.pruned
    }
  }

  private accept(entry: UiLogEntry): void {
    const refusal = uiRecordRefusal(entry)
    if (refusal !== null) return this.refuse(refusal)
    if (entry.level === 'debug' && this.deps.level !== 'debug') return
    const now = this.deps.clock.now()
    for (const summary of this.folder.expired(now)) this.enqueueEntry(summary, now)
    const line = this.lineOf(entry, now)
    if (typeof line !== 'string') return this.refuse(line.refused)
    if (!this.folder.offer(entry, now)) return
    this.enqueue(line)
  }

  /** The JSON line of `entry` at `now`, with the writer-filled fields. */
  private lineOf(entry: UiLogEntry, now: number): ReturnType<typeof toLogLine> {
    const record: LogRecord = {
      ts: new Date(now).toISOString(),
      proc: 'ui',
      pid: this.deps.pid,
      appVersion: this.deps.appVersion,
      ...entry
    }
    // ADR-026 item 5: frames made relative to the app root; `toLogLine` runs the pipeline again.
    if (typeof record.stack === 'string')
      record.stack = redactStack(record.stack, this.deps.appRoot)
    return toLogLine(record)
  }

  /** Writes a folded summary or an internal record (they passed the rules as their first copy). */
  private enqueueEntry(entry: UiLogEntry, now: number): void {
    const line = this.lineOf(entry, now)
    if (typeof line === 'string') this.enqueue(line)
    else this.refuse(line.refused)
  }

  private enqueue(line: string): void {
    this.tail = this.tail.then(() => this.write(line))
  }

  private async write(line: string): Promise<void> {
    if (!(await this.appended(line))) {
      this.failed += 1
      this.drop('write-failed')
      return
    }
    this.written += 1
    await this.reportDrops()
  }

  /** 19 §9.6 `log.dropped`: written at the next successful write after records were dropped. */
  private async reportDrops(): Promise<void> {
    for (const [cause, count] of [...this.unreported]) {
      this.unreported.delete(cause)
      const line = this.lineOf(
        { level: 'warn', event: 'log.dropped', subsystem: SUBSYSTEM, causeClass: cause, count },
        this.deps.clock.now()
      )
      if (typeof line !== 'string' || !(await this.appended(line))) {
        this.unreported.set(cause, (this.unreported.get(cause) ?? 0) + count)
        return
      }
      this.written += 1
    }
  }

  /** One append through the writer; an adapter that throws counts as a failed write. */
  private async appended(line: string): Promise<boolean> {
    try {
      return await this.writer.append(line)
    } catch {
      return false
    }
  }

  private refuse(cause: 'sensitive' | 'field-not-allowed'): void {
    this.refused += 1
    this.drop(cause)
  }

  private drop(cause: DropCause): void {
    this.unreported.set(cause, (this.unreported.get(cause) ?? 0) + 1)
  }

  /** 19 §9.6 `log.pruned` (debug): segments a prune run deleted and their bytes. */
  private onPruned(run: { count: number; bytes: number }): void {
    this.pruned += run.count
    if (this.deps.level !== 'debug') return
    this.enqueueEntry(
      {
        level: 'debug',
        event: 'log.pruned',
        subsystem: SUBSYSTEM,
        count: run.count,
        bytes: run.bytes
      },
      this.deps.clock.now()
    )
  }
}

/** Throws `TypeError` when `appVersion` is not a build version (a composition defect). */
export function createUiLogger(deps: UiLoggerDeps): UiLogger {
  return new UiLogger(deps)
}
