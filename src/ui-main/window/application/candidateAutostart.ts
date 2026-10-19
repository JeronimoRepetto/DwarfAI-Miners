// The candidate login autostart (21 §2 cut 1, "Login autostart entry"): today's start-at-login behaviour, ported
// unchanged from `src/main/shell/autostart.ts` (`migrateLegacyAutostart`, `ensureDefaultAutostart`) so UI main owns it
// before the legacy runtime is deleted (ISSUE-243). The Electron root composes it only in a packaged build of an OS
// where S-027-4 has not passed (loginEntryGate.ts): there it stays the one writer of the entry until v1 (21 §1 item 4).
//
// At each start: the one-time migration of a pre-rename entry first, then the once-only default: the entry is turned on
// at the first packaged start, and the default marker is written only after the OS took the write, so a refused write
// is retried at the next start. A failure is logged (`autostart.register`, 19 §9.6), never shown.
import type { CandidateDefaultMarker, CandidateLoginEntry } from '../ports/candidateLoginEntry'
import type { AutostartRegisterRecord } from './startWithSystem'

export interface CandidateAutostartDeps {
  entry: CandidateLoginEntry
  marker: CandidateDefaultMarker
  log(record: AutostartRegisterRecord): void
}

/** An error's code (`EACCES`, …) or class name, never its message (ADR-026 item 4). */
function errCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code
  return error instanceof Error ? error.name : 'unknown'
}

export function createCandidateAutostart(deps: CandidateAutostartDeps): () => Promise<void> {
  const { entry, marker, log } = deps
  /** `migrate on` for the pre-rename migration, `start on` for the once-only default. */
  const failed = (what: 'migrate' | 'start', error: unknown): void =>
    log({
      level: 'warn',
      event: 'autostart.register',
      subsystem: 'window',
      outcome: 'failed',
      causeClass: 'failed',
      errCode: errCodeOf(error),
      msg: `${what} on`
    })

  return async () => {
    try {
      await entry.migrateLegacy()
    } catch (error) {
      failed('migrate', error)
    }
    if (await marker.exists()) return
    try {
      await entry.enable()
      await marker.write()
    } catch (error) {
      // No marker: the next start retries.
      failed('start', error)
    }
  }
}
