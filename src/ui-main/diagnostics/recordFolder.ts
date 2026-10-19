// Rate limiting of the UI log (ADR-026 item 6; 19 §6): identical (event, subsystem, causeClass, dwarfId) records
// within 60 s fold into one record with `count` (HO-33 dedup). The Host has the same rule in its diagnostics
// domain, which the UI tree may not import (R10). Pure: time is passed in.

/** The fold window (ADR-026 item 6): a repeat at most this long after the first is folded. */
export const FOLD_WINDOW_MS = 60_000

/** The fields that make two records identical for folding (ADR-026 item 6). */
export interface FoldableRecord {
  readonly event: string
  readonly subsystem: string
  readonly causeClass?: string
  readonly dwarfId?: string
  readonly count?: number
}

interface FoldWindow<R> {
  readonly openedAt: number
  readonly sample: R
  folded: number
}

/**
 * The first record of a window is written at once; each identical record inside the window is folded into it.
 * When the window has passed, `expired` returns one record per window that folded repeats, with their number in
 * `count`.
 */
export class RecordFolder<R extends FoldableRecord> {
  private readonly windows = new Map<string, FoldWindow<R>>()

  /** `true` when `record` is to be written now, `false` when it was folded into its window. */
  offer(record: R, now: number): boolean {
    const key = JSON.stringify([
      record.event,
      record.subsystem,
      record.causeClass ?? null,
      record.dwarfId ?? null
    ])
    const window = this.windows.get(key)
    if (window !== undefined && now - window.openedAt <= FOLD_WINDOW_MS) {
      window.folded += 1
      return false
    }
    this.windows.set(key, { openedAt: now, sample: record, folded: 0 })
    return true
  }

  /** The folded repeats of every window that has passed at `now`, one record each; passed windows are dropped. */
  expired(now: number): R[] {
    const summaries: R[] = []
    for (const [key, window] of this.windows) {
      if (now - window.openedAt <= FOLD_WINDOW_MS) continue
      this.windows.delete(key)
      if (window.folded > 0) summaries.push({ ...window.sample, count: window.folded })
    }
    return summaries
  }
}
