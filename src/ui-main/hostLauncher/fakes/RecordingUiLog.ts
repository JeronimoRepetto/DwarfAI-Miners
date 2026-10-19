// The UiLog double: keeps every record. Never imported by production code (R14).
import type { UiLog, UiLogEntry } from '../../diagnostics/uiLogger'

export class RecordingUiLog implements UiLog {
  readonly entries: UiLogEntry[] = []

  record(entry: UiLogEntry): void {
    this.entries.push(entry)
  }

  byEvent(event: string): UiLogEntry[] {
    return this.entries.filter((entry) => entry.event === event)
  }
}
