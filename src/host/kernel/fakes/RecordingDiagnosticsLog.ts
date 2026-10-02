// The DiagnosticsLog double (16 §2.8, §3): keeps every entry a module recorded so a test can assert
// what was logged. Never imported by production code (R14).
//
// It meets the DiagnosticsLog contract (kernel/testing/diagnosticsLog.contract.ts) as the real log
// does: an entry the ADR-026 allowlist refuses (`toLogLine` of contracts/logging, the same rule the
// Host's log applies) is not kept but set aside in `refused`, and `record` never throws, so an L2
// test cannot assert a record the real log would drop.
import { toLogLine } from '../../../contracts/logging'
import type { DiagnosticEntry, DiagnosticsLog } from '../ports/diagnosticsLog'

/** The writer-filled fields (16 §3 `DiagnosticEntry`), with fixed values: only the entry is judged. */
const WRITER_FIELDS = {
  ts: '2026-01-01T00:00:00.000Z',
  proc: 'host',
  pid: 1,
  appVersion: '0.0.0'
} as const

export class RecordingDiagnosticsLog implements DiagnosticsLog {
  /** Every entry passed to `record` that the allowlist admits, in call order. */
  readonly entries: DiagnosticEntry[] = []
  /** Every entry the allowlist refused, with why, in call order. */
  readonly refused: Array<{ entry: DiagnosticEntry; refused: 'sensitive' | 'field-not-allowed' }> =
    []

  record(entry: DiagnosticEntry): void {
    const line = toLogLine({ ...WRITER_FIELDS, ...entry })
    if (typeof line === 'string') this.entries.push(entry)
    else this.refused.push({ entry, refused: line.refused })
  }

  /** The entries whose `event` is `event`. */
  byEvent(event: string): DiagnosticEntry[] {
    return this.entries.filter((entry) => entry.event === event)
  }
}
