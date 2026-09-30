// The DiagnosticsLog double (16 §2.8, §3): keeps every entry a module recorded so a test can assert
// what was logged. Never imported by production code (R14).
import type { DiagnosticEntry, DiagnosticsLog } from '../ports/diagnosticsLog'

export class RecordingDiagnosticsLog implements DiagnosticsLog {
  /** Every entry passed to `record`, in call order. */
  readonly entries: DiagnosticEntry[] = []

  record(entry: DiagnosticEntry): void {
    this.entries.push(entry)
  }

  /** The entries whose `event` is `event`. */
  byEvent(event: string): DiagnosticEntry[] {
    return this.entries.filter((entry) => entry.event === event)
  }
}
