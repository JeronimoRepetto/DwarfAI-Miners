// The DrainGate binding of cut 0 (ADR-002 D8; lead decision 2026-09-30 in ISSUE-032): no session
// exists yet, so nothing is open or in flight and the upgrade drain goes at once. host/main.ts
// binds it until the launching (EPIC-10) and asking (EPIC-08) modules report their blockers.
import type { DrainBlocker, DrainGate } from '../kernel/ports/drainGate'

export const emptyDrainGate: DrainGate = {
  blockers: (): readonly DrainBlocker[] => []
}
