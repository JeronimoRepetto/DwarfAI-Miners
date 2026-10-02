// The Reset-metrics saga's participants (ADR-023 item 4; 16 §4.12 `ResetDbStep`; 09 §7.2), in the
// order the saga runs them. The preferences module imports no other module (05 §1.3), so host
// wiring hands it every module's table set here (hot spot, 22 §5):
//
// - `dbSteps`: joined in the one `db` transaction, in the 09 §7.2 order — (2) mines and crew,
//   (3) the other per-table deletions, (4) launching. Cut 1 registers the preferences step only;
//   the others join with their issues, each in its place (later: ISSUE-097, ISSUE-107, ISSUE-118,
//   ISSUE-121, ISSUE-139, ISSUE-181, ISSUE-208).
// - `installMoment`: the ledger's `install_moment(now, 'reset')` (07 S13.05), written through
//   `LedgerRepository.setInstallMoment` (16 §11) in its own transaction at that step (lead
//   decision 2026-09-30: the `ResetDbStep` shape, no new port type).
import type { Instant } from '../kernel/domain/values'
import type { Clock } from '../kernel/ports/clock'
import type { ResetDbStep } from '../modules/preferences'

/** The member of the ledger's `LedgerRepository` (16 §11) the install-moment step calls. */
export interface LedgerInstallMoment {
  setInstallMoment(t: Instant): void
}

export interface ResetParticipantsDeps {
  /** The preferences module's step (`createPreferencesResetStep`). */
  preferences: ResetDbStep
  ledger: LedgerInstallMoment
  clock: Clock
}

export interface ResetParticipants {
  dbSteps: readonly ResetDbStep[]
  installMoment: ResetDbStep
}

export function resetParticipants(deps: ResetParticipantsDeps): ResetParticipants {
  return {
    dbSteps: [deps.preferences],
    installMoment: {
      name: 'ledger-install-moment',
      reset: (tx) => tx.inTransaction(() => deps.ledger.setInstallMoment(deps.clock.now()))
    }
  }
}
