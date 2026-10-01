// The StopAllPort binding of cut 0 (ADR-002 D7; ISSUE-029): the Host owns no session yet, so
// Stop everything and quit ends nothing and always answers `{ ended: [], failed: [] }`, and the
// Host then checkpoints and exits (S12.12). host/main.ts binds it until the launching module
// serves `stopAll` through `crew.endOwned` (later: ISSUE-175), which replaces this file.
import type { StopAllOutcome, StopAllPort } from '../kernel/ports/stopAll'

export const emptyOwnerStopAll: StopAllPort = {
  stopAll: (): Promise<StopAllOutcome> => Promise.resolve({ ended: [], failed: [] })
}
