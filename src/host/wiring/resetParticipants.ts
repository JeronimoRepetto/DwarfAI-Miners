// The Reset-metrics saga's participants (ADR-023 item 4; 16 §4.12 `ResetDbStep`; 09 §7.2), in the
// order the saga runs them. The preferences module imports no other module (05 §1.3), so host
// wiring hands it every module's table set here (hot spot, 22 §5):
//
// - `dbSteps`: joined in the one `db` transaction, in the 09 §7.2 order — (2) mines and crew,
//   (3) the other per-table deletions, (4) launching. Cut 1 registers (2) the mines and crew steps
//   and (3) the preferences, observation, ledger, conversation, asking and attention steps
//   (ISSUE-121, ISSUE-118, ISSUE-139; the module steps are built by moduleResetSteps.ts). The deletions of (2) go first:
//   their cascades take the departed dwarfs' rows (messages, keys, usage), so the steps of (3)
//   delete only what the present dwarfs and the kept mines leave. The others join with their
//   issues, each in its place (later: ISSUE-181, ISSUE-208).
// - `installMoment`: the ledger's `install_moment(now, 'reset')` (07 S13.05), written through
//   `LedgerRepository.setInstallMoment` (16 §4.10; `SqliteLedgerRepository`) in its own
//   transaction at that step (lead decision 2026-09-30: the `ResetDbStep` shape, no new port
//   type).
import type { Clock } from '../kernel/ports/clock'
import type { LedgerRepository } from '../modules/ledger'
import type { ResetDbStep } from '../modules/preferences'

/** The member of the ledger's `LedgerRepository` (16 §4.10) the install-moment step calls. */
export type LedgerInstallMoment = Pick<LedgerRepository, 'setInstallMoment'>

/** The cut-1 board and conversation modules' steps (moduleResetSteps.ts, ISSUE-121). */
export interface ModuleResetSteps {
  /** `createMinesResetStep`: 09 §7.2 (2), mines with no present dwarf deleted (cascades). */
  mines: ResetDbStep
  /** `createCrewResetStep`: 09 §7.2 (2), departed dwarfs deleted (cascades). */
  crew: ResetDbStep
  /** `createObservationResetStep`: 09 §7.2 (3). */
  observation: ResetDbStep
  /** `createLedgerResetStep`: 09 §7.2 (3). */
  ledger: ResetDbStep
  /** `createConversationResetStep`: 09 §7.2 (3). */
  conversation: ResetDbStep
  /** `createAskingResetStep`: 09 §7.2 (3), closed asks deleted (cascades) before attention's. */
  asking: ResetDbStep
}

export interface ResetParticipantsDeps {
  /** The preferences module's step (`createPreferencesResetStep`). */
  preferences: ResetDbStep
  /** The mines, crew, observation, ledger, conversation and asking steps. */
  modules: ModuleResetSteps
  /** The attention module's step (`createAttentionResetStep`). */
  attention: ResetDbStep
  ledger: LedgerInstallMoment
  clock: Clock
}

export interface ResetParticipants {
  dbSteps: readonly ResetDbStep[]
  installMoment: ResetDbStep
}

export function resetParticipants(deps: ResetParticipantsDeps): ResetParticipants {
  const { modules } = deps
  return {
    dbSteps: [
      // (2): the mines with no present dwarf, then the departed dwarfs (both cascade).
      modules.mines,
      modules.crew,
      // (3): the other per-table deletions; attention's follows the asks (ISSUE-118).
      deps.preferences,
      modules.observation,
      modules.ledger,
      modules.conversation,
      // The closed asks go first (their keys cascade), so attention finds only the keys that
      // remain (ISSUE-139).
      modules.asking,
      deps.attention
    ],
    installMoment: {
      name: 'ledger-install-moment',
      reset: (tx) => tx.inTransaction(() => deps.ledger.setInstallMoment(deps.clock.now()))
    }
  }
}
