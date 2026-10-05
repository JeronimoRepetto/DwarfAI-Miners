// Driven port of the coal backfill (16 §4.10 `HistoricalUsageScanner`; 05 §3.10; 09 §5.5).
// Type-only (05 R2).
//
// `scan(before, budget, signal)` reads provider history by its own bounded scan (never through
// `source_cursors`) and yields one item per scan unit (a Claude project directory, a Codex day
// directory, the OpenCode store), each finished whole before it is yielded, so the backfill
// commits a unit's credits and its `coal_backfill_units` row in one transaction (09 §5.5).
//
// - Per-unit records carry the live `unitKey` (ADR-006 item 8); a stream that only yields a
//   lifetime total carries `coal:<streamId>` and its newest record time (`span: 'lifetime'`).
// - Only records whose folder resolves to a mine are yielded (`11` O-11-10 stays open: no coal
//   for folders that are not mines).
// - The scan spends nothing on `budget.finishedScanUnits`, stops between units once the per-boot
//   budget is reached (yielding `budget-reached` last), and stops at once when `signal` aborts.
// - A unit that cannot be read is yielded as `unreadable` and never as `scanned` (S19.08).
//
// Package gap: 16 §4.10 names `ScanBudget` and `HistoricalUsage` without fields. The budget is
// 09 §5.5's (`DEFAULT_MAX_FILES`, `DEFAULT_MAX_DURATION_MS`, `DEFAULT_MAX_FILES_PER_DIR`) plus the
// units the resumed scan skips (S19.04, S19.07): `scan` takes no other input that could carry them.
import type { Instant, MineId } from '../../../kernel/domain/values'
import type { UnitKey } from '../domain/credit'

/** The per-boot budget of one scan (09 §5.5; 16 §2.6). */
export interface ScanBudget {
  /** Files whose contents one run reads, before the scan stops between units. */
  maxFiles: number
  /** Wall-clock budget of one run, on the injected clock. */
  maxDurationMs: number
  /** Files read from one scan unit (a project directory, a Codex day). */
  maxFilesPerDir: number
  /** Scan units already recorded for this install moment: never read again. */
  finishedScanUnits: ReadonlySet<string>
}

/** One record of historical usage the backfill may pay as coal. */
export interface HistoricalUsageRecord {
  /** The live `unitKey` for a per-unit record; `coal:<streamId>` for a lifetime total. */
  unitKey: UnitKey
  /** `'unit'`: one accounted unit; `'lifetime'`: a whole stream's running total (09 §5.5). */
  span: 'unit' | 'lifetime'
  /** The mine the record's folder resolves to (worktree fold included). */
  mineId: MineId
  /** Every token kind added together (`usageTokens`). */
  tokens: number
  /** The unit's provider time, or the stream's newest record time for a lifetime total. */
  providerTime: Instant
}

/** One item of a scan: a finished unit, an unreadable unit, or the budget stop. */
export type HistoricalUsage =
  | {
      kind: 'scanned'
      /** `coal_backfill_units.scan_unit`. */
      scanUnit: string
      /** `coal_backfill_units.adapter_id`: the provider whose history it is. */
      adapterId: string
      records: HistoricalUsageRecord[]
    }
  | {
      kind: 'unreadable'
      scanUnit: string
      adapterId: string
      /** A fixed reason code, never content or a path (ADR-026 item 4). */
      errCode: string
    }
  | { kind: 'budget-reached' }

export interface HistoricalUsageScanner {
  scan(before: Instant, budget: ScanBudget, signal: AbortSignal): AsyncIterable<HistoricalUsage>
}
