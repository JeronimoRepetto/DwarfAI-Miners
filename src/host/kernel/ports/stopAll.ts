// Kernel driven port (ADR-002 D7 step 3; 16 §1 launching `stopAll`; 06 INV-120, INV-121): what
// `host.shutdown {mode:'stop-all'}` (B-M05) asks to end every owned session. It settles only after
// every end settled, with each owned dwarf in `ended` or in `failed`; it never signals an observed
// session (INV-120). The transport decides from `failed` whether the Host exits (S12.12) or keeps
// running (S12.21).
//
// host/main.ts binds an empty-owner implementation until the launching module serves it through
// `crew.endOwned` (later: ISSUE-175).
//
// `StopAllOutcome` is 06 §0.2's, owned by `contracts/wire` (ISSUE-009 / ISSUE-029), imported as a
// type only and never restated.
import type { StopAllOutcome } from '../../../contracts/wire'

export type { StopAllOutcome } from '../../../contracts/wire'

export interface StopAllPort {
  stopAll(requestId: string): Promise<StopAllOutcome>
}
