// The OS session end (logout, shutdown, reboot) → a clean exit with the marker reason
// `os-session-end` (07 S12.10; ADR-002 D7 (c)), so the next boot does not resume the sessions
// (OQ-55; S4.24). What counts as a session end on each OS is the platform adapter's
// (host/platform/process/osSessionSignals.ts, R18); this maps its report.
import type { CleanExit } from './cleanExit'

/** What the platform adapter reports: each OS session end it detects. */
export interface OsSessionEndSource {
  onSessionEnd(listener: () => void): void
}

export function closeOnOsSessionEnd(source: OsSessionEndSource, exit: CleanExit): void {
  source.onSessionEnd(() => void exit.closeCleanly('os-session-end'))
}
