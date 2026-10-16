// The asking module's blockers of the upgrade drain (ADR-002 D8 item 2; 07 S12.14, S12.15; lead decision 2026-09-30 in
// ISSUE-032: the asking module binds its blockers to the kernel `DrainGate`; #1290).
//
// D8 item 2 lets the drain go only when "no ask is open and nothing is in flight". Every live ask
// (`AskRepository.live`, owner amendment L) holds it: an `open` ask as `open-ask`, an `answering` ask, whose answer is
// being handed to the provider (S6.06), as `in-flight`. D8 item 2 names no channel or origin, so an observed session's
// ask holds the drain as a launched one's does. A closed ask holds nothing. It only reads: the drain waits, it never
// closes or answers an ask (ADR-002 D8 items 3–4).
import type { DwarfId } from '../../../kernel/domain/values'
import type { DrainBlocker, DrainGate } from '../../../kernel/ports/drainGate'
import type { AskRepository } from '../ports/askRepository'

export interface AskDrainGateDeps {
  asks: Pick<AskRepository, 'live'>
}

export class AskDrainGate implements DrainGate {
  constructor(private readonly deps: AskDrainGateDeps) {}

  blockers(): readonly DrainBlocker[] {
    return this.deps.asks.live().map((ask): DrainBlocker => ({
      kind: ask.state === 'answering' ? 'in-flight' : 'open-ask',
      dwarfId: ask.dwarfId as DwarfId
    }))
  }
}
