// The UI writer's driven port over the shared `logs/` folder (05 §3.13 "UI: its own FsSegmentWriter in
// src/ui-main/diagnostics"; ADR-026 items 1–2). The Host's segment writer works over the kernel `FileSystem` and
// `LogDirectory` ports, which the UI tree may not import (R10); this port is the UI's own, with the same
// semantics: a listing of the segment files with their sizes and first-record timestamps, an append, a delete and
// a folder creation, each reporting an OS failure as a value, never as a throw.
import type { SegmentInfo } from '@dwarfai/contracts'

/** How one append ended: `not-found` when the folder vanished (another writer's prune, a person deleting it). */
export type AppendOutcome = 'ok' | 'not-found' | 'failed'

export interface LogFiles {
  /** Creates `dir` and its parents when missing; `false` when it cannot be created. */
  makeDir(dir: string): Promise<boolean>
  /** Appends `data` (UTF-8) to the file at `path`, creating the file when missing. */
  append(path: string, data: string): Promise<AppendOutcome>
  /** Deletes the file at `path`; `false` when it was not deleted (an `ENOENT` race is one). */
  remove(path: string): Promise<boolean>
  /**
   * The segment files of `dir` (`<prefix><six-digit seq>.jsonl`, 19 §2) with their byte sizes and the `ts` of
   * their first record (`''` when it cannot be read, an empty segment); any other file is not listed, and a
   * missing folder lists nothing.
   */
  segments(dir: string): Promise<SegmentInfo[]>
}
