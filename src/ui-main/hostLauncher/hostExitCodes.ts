// The Host's exit codes as the launcher reads them (ADR-002 D3, D6; 07 S12.02, S12.03; 13 FM-008,
// FM-009, FM-011). The Host defines them in `src/host/wiring/exitCodes.ts` (ISSUE-021); the UI
// tree may not import the Host (R10), so the numbers are restated here and must stay equal to
// that file's. The OS lane's fake Host (fixtures/bin/fake-host) exits with the same numbers.
//
// - ALREADY_RUNNING → another Host holds the endpoint: attach to it;
// - ELEVATED_REFUSED → `unavailable{elevated-refused}`;
// - NO_DATA_DIR, a failed boot (1) and any other code → `unavailable{spawn-failed}`.
export const HOST_EXIT_CODES = Object.freeze({
  ALREADY_RUNNING: 64,
  ELEVATED_REFUSED: 65,
  NO_DATA_DIR: 66
})
