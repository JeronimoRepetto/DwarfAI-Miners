// Crew's side of the observed-session index for in-memory tests (17 §1.2): the dwarf bound to an
// identity, as `crew.arrive` would store it. A test plays crew's route with `bind` and `depart`.
// Never imported by production code (R14).
import { providerIdentityKey } from '../../../kernel/domain/providerIdentity'
import type { DwarfId, FolderPath, Instant, ProviderIdentity } from '../../../kernel/domain/values'
import type { BoundDwarf, BoundDwarfs } from '../ports/fakes/InMemoryObservedSessionStore'

export class InMemoryBoundDwarfs implements BoundDwarfs {
  private readonly byKey = new Map<string, BoundDwarf>()
  private count = 0

  bound(i: ProviderIdentity): BoundDwarf | null {
    const dwarf = this.byKey.get(providerIdentityKey(i))
    return dwarf === undefined ? null : { ...dwarf }
  }

  /** A dwarf arrives for `identity` (the existing one when already bound, as `arrive` does). */
  bind(identity: ProviderIdentity, folder: FolderPath, at: Instant): DwarfId {
    const key = providerIdentityKey(identity)
    const existing = this.byKey.get(key)
    if (existing !== undefined) return existing.dwarfId
    const dwarfId =
      `00000000-0000-7000-8000-${(++this.count).toString(16).padStart(12, '0')}` as DwarfId
    this.byKey.set(key, { dwarfId, folder, arrivedAt: at, departedAt: null })
    return dwarfId
  }

  depart(dwarfId: DwarfId, at: Instant): void {
    for (const dwarf of this.byKey.values()) {
      if (dwarf.dwarfId === dwarfId) dwarf.departedAt = at
    }
  }
}
