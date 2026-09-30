// Rate limiting of the log (ADR-026 item 6; 19 §6): identical (event, subsystem, causeClass,
// dwarfId) records within 60 s fold into one record with `count` (HO-33 dedup). Pure: time is
// passed in, nothing is read from a clock (05 §2.2, R1).
import type { Instant } from '../../../kernel/domain/values'

/** The fold window (ADR-026 item 6): a repeat at most this long after the first is folded. */
export const RATE_LIMIT_WINDOW_MS = 60_000

/** The fields that make two records identical for folding (ADR-026 item 6). */
export interface FoldableRecord {
  readonly event: string
  readonly subsystem: string
  readonly causeClass?: string
  readonly dwarfId?: string
  readonly count?: number
}

interface FoldWindow<R extends FoldableRecord> {
  readonly openedAt: Instant
  readonly sample: R
  folded: number
}

/**
 * Folds identical records. The first record of a window is written at once; each identical record
 * inside the window is folded into it. When the window has passed, `expired` returns one record
 * per window that folded repeats, carrying their number in `count`.
 */
export class RecordFolder<R extends FoldableRecord> {
  private readonly windows = new Map<string, FoldWindow<R>>()

  /** `true` when `record` is to be written now, `false` when it was folded into its window. */
  offer(record: R, now: Instant): boolean {
    const key = foldKey(record)
    const window = this.windows.get(key)
    if (window !== undefined && now - window.openedAt <= RATE_LIMIT_WINDOW_MS) {
      window.folded += 1
      return false
    }
    this.windows.set(key, { openedAt: now, sample: record, folded: 0 })
    return true
  }

  /**
   * The folded repeats of every window that has passed at `now`, as one record each (the window's
   * first record with `count` = the number of repeats folded into it). Passed windows are dropped,
   * so the folder holds only the keys seen in the last 60 s.
   */
  expired(now: Instant): R[] {
    const summaries: R[] = []
    for (const [key, window] of this.windows) {
      if (now - window.openedAt <= RATE_LIMIT_WINDOW_MS) continue
      this.windows.delete(key)
      if (window.folded > 0) summaries.push({ ...window.sample, count: window.folded })
    }
    return summaries
  }
}

function foldKey(r: FoldableRecord): string {
  return JSON.stringify([r.event, r.subsystem, r.causeClass ?? null, r.dwarfId ?? null])
}
