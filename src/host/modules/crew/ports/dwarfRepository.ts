// Driven port of crew (05 §3.2, 16 §4.2 `DwarfRepository`): the aggregate store of `dwarfs`
// (09 §4.2). The provider identity is a UNIQUE key (ADR-015 item 7, INV-21): `save` of a second
// dwarf with an identity already bound to another one is refused by throwing (a code defect,
// 16 §2.1), and changes nothing. `save` runs inside the caller's transaction (16 §2.2).
//
// Stored: every field of `Dwarf` except two that are Host memory (09 §4.2 has no column for
// them): the `pendingEnd` of a Host-requested end and the `facts.openAsk` the ask broker reports.
// A dwarf read back carries `pendingEnd: null` and no `openAsk`.
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import type { Dwarf } from '../domain/dwarf'

export interface DwarfRepository {
  byId(id: DwarfId): Dwarf | null
  byProviderIdentity(i: ProviderIdentity): Dwarf | null
  /** Every dwarf of the mine, departed ones included, in arrival order. */
  inMine(id: MineId): Dwarf[]
  save(d: Dwarf): void
}
