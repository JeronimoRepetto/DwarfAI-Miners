// The Host's exit codes (ADR-002 D3, D6; 07 S12.02, S12.03; 13 FM-008, FM-009, FM-011). The UI's
// Host launcher (later: ISSUE-030) maps each to its `HostConnection` outcome: ALREADY_RUNNING →
// attach to the running Host, ELEVATED_REFUSED → `unavailable{elevated-refused}`, NO_DATA_DIR and
// a failed boot → `unavailable{spawn-failed}`.
//
// The package names the codes but not their numbers. 1 is what Node itself exits with on an
// uncaught exception, so a failed boot shares it (both are FM-008 to the UI). The refusals take
// numbers of their own, clear of the codes Node documents for its own failures (1–14) and of the
// signal exits (128 + signal number).

/** Why a Host refuses to start, by the names of ADR-002 and ADR-002 D6's spawn contract. */
export type HostRefusal = 'ALREADY_RUNNING' | 'ELEVATED_REFUSED' | 'NO_DATA_DIR'

export const EXIT_CODES: Readonly<Record<HostRefusal, number>> = Object.freeze({
  ALREADY_RUNNING: 64,
  ELEVATED_REFUSED: 65,
  NO_DATA_DIR: 66
})

/** A boot step threw (FM-008): the boot stopped before `ready`. */
export const BOOT_FAILED_EXIT_CODE = 1
