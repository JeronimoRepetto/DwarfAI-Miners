// Driven port of crew (05 §3.2, 16 §4.2 `SessionTerminator`): how crew asks the Host to end a
// dwarf's session. The shape is ADR-014 item 1's (frozen), typed with the Host's aliases as `05`
// §3.2 restates it: `EndReason` is item 1's `why`, `EndOutcome` and its `'no-identity'` reason are
// item 1's (kernel `processIdentity`). Implemented in `host/wiring` (bridges/sessionTerminator):
// observed sessions by the kernel's identity-checked tree kill, owned and shared-server sessions by
// the suppliers channel once EPIC-09/EPIC-10 bind it. The custom name is never part of a call
// (NFR-PRIV-03). Type-only (05 §2.2, R2).
import type { EndOutcome } from '../../../kernel/domain/processIdentity'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { EndReason } from '../domain/presence'

export type { EndOutcome } from '../../../kernel/domain/processIdentity'
export type { EndReason } from '../domain/presence'

export interface SessionTerminator {
  /**
   * Ends the dwarf's session (ADR-014 items 1–4). `ended` only once the OS confirmed the exit, or
   * the recorded process no longer exists; a session with no process identity and no protocol
   * close path is `failed: 'no-identity'` with nothing signalled (item 2).
   */
  end(dwarfId: DwarfId, why: EndReason): Promise<EndOutcome>
  /** Every present dwarf of the mine, in parallel, one outcome per dwarf (ADR-014 item 1). */
  endAll(mineId: MineId): Promise<Map<DwarfId, EndOutcome>>
}
