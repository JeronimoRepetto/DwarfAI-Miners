// What today's runtime, composed through LegacyRuntimeRoute, writes to the UI log instead of the
// console (ADR-026 items 3–5, Verification "console.* forbidden outside the logger"; 19 §1, §7).
//
// Today's composition printed its warnings with their free text and the raw error: paths, provider
// output, config values. A log line never holds those (19 §7), so a warning becomes one allowlisted
// record with identifier fields only:
// - `legacy.warning` (warn): `causeClass` = the area of today's runtime that warned, `errCode` = the
//   error's code, else its class name; the message and the error's message are dropped. This event
//   is not in 19 §9 (today's runtime is not a module of the package); it lives until cut 5 deletes
//   the legacy tree, and is recorded as a package gap in the hand-off;
// - a preference store write that failed is the 19 §9.6 `uiprefs.write-failed` record (`msg` = the
//   store name, `errCode`), as the rebuilt stores log it.
// Today's informational console lines (the config dump, hook events, backfill totals, the Jev debug
// sink) are not routed: they carry paths and content and have no event of their own.
import type { LogRecord } from '@dwarfai/contracts'

/** A record as the UI logger takes it: every `LogRecord` field except those the writer fills. */
export type LegacyLogEntry = Omit<LogRecord, 'ts' | 'proc' | 'pid' | 'appVersion'>

/** The UI logger, as today's composition reaches it (handed in by the Electron root). */
export interface LegacyLog {
  record(entry: LegacyLogEntry): void
}

/** The parts of today's runtime that warn, as the record's `causeClass`. */
export type LegacyArea =
  | 'config'
  | 'autostart'
  | 'ledger'
  | 'projects'
  | 'coal-backfill'
  | 'hooks'
  | 'opencode-plugin'
  | 'shortcut'
  | 'jev-key'
  | 'jev-route'
  | 'jev-preferences'
  | 'opencode-password'
  | 'mine-path'
  | 'external-link'

/** Today's preference stores, by the name `uiprefs.write-failed` carries as `msg`. */
export type LegacyPreferenceStore =
  'pin' | 'panel-edge' | 'shortcut' | 'audio' | 'typography' | 'notifications'

export interface LegacyDiagnostics {
  /** A warning of today's runtime: its area, and the error's code or class when there is one. */
  warning(area: LegacyArea, error?: unknown): void
  /** A preference store could not write its file (19 §9.6, FM-053). */
  preferenceWriteFailed(store: LegacyPreferenceStore, error: unknown): void
}

const SUBSYSTEM = 'legacy-runtime'

/** The identifier shape the UI writer accepts for `errCode` (ui-main/diagnostics/uiRecordRules.ts). */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/

export function createLegacyDiagnostics(log: LegacyLog): LegacyDiagnostics {
  return {
    warning(area, error) {
      log.record({
        level: 'warn',
        event: 'legacy.warning',
        subsystem: SUBSYSTEM,
        causeClass: area,
        ...errCodeOf(error)
      })
    },
    preferenceWriteFailed(store, error) {
      log.record({
        level: 'warn',
        event: 'uiprefs.write-failed',
        subsystem: SUBSYSTEM,
        msg: store,
        ...errCodeOf(error)
      })
    }
  }
}

/** The error's code, else its class name; nothing for a string or any other value (ADR-026 item 5). */
function errCodeOf(error: unknown): { errCode?: string } {
  if (!(error instanceof Error)) return {}
  const code = (error as { code?: unknown }).code
  const errCode = [code, error.name].find(
    (value): value is string => typeof value === 'string' && ERROR_CODE.test(value)
  )
  return errCode === undefined ? {} : { errCode }
}
