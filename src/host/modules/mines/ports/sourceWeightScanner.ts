// Mines driven port (05 §3.1, 16 §4.1 row `SourceWeightScanner`): the weight of a mine's source
// files, the only input of its tier (INV-05, BR-15). It counts the bytes of source-ish files under
// the folder, skipping dependency and build directories (06 §4.1 `SourceWeight`), off the event
// loop in a cancellable worker (HR O2). It never rejects: a folder that cannot be read answers
// `{ unenterable }` with the reason, and an aborted call resolves promptly without a weight
// (`{ unenterable: 'aborted' }`), which the caller that aborted discards (S3.15). Adapter:
// FsSourceWeightScanner; double: FakeSourceWeightScanner. Type-only (05 R2).
import type { FolderPath } from '../../../kernel/domain/values'

export interface SourceWeightScanner {
  measure(
    path: FolderPath,
    signal: AbortSignal
  ): Promise<{ bytes: number } | { unenterable: string }>
}

/** What an aborted measurement resolves with: no weight, and never a reason a mine is given. */
export type AbortedMeasurement = { unenterable: 'aborted' }
