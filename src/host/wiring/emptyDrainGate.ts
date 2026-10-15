// The DrainGate binding of cut 0 (ADR-002 D8; lead decision 2026-09-30 in ISSUE-032): no session
// exists yet, so nothing is open or in flight and the upgrade drain goes at once. Since #1290
// host/main.ts binds wiring/hostDrainGate.ts instead, which reports the same empty list until a
// module's gate is bound to it (the asking module's at boot step 4; the launching module's later:
// EPIC-10).
import type { DrainBlocker, DrainGate } from '../kernel/ports/drainGate'

export const emptyDrainGate: DrainGate = {
  blockers: (): readonly DrainBlocker[] => []
}
