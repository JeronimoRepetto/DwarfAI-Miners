// Kernel driven port (05 §3, 16 §3 row `DiagnosticsLog`): the one logging entry point of every Host
// module, implemented by the diagnostics module through a SegmentWriter('host') (05 §3.13). It never
// throws into the caller; a refused or unwritable record is dropped and counted.
//
// `LogRecord` is ADR-026 item 3, owned verbatim by `contracts/logging` (ISSUE-012). It is imported
// as a type only, so the entry is derived from its owner and never restated.
import type { LogRecord } from '../../../contracts/logging'

export interface DiagnosticsLog {
  record(entry: DiagnosticEntry): void
}

/** ADR-026 `LogRecord` without the fields the writer fills: `ts`, `proc`, `pid`, `appVersion`. */
export type DiagnosticEntry = Omit<LogRecord, 'ts' | 'proc' | 'pid' | 'appVersion'>
