// The DwarfRepository double (16 §4.2, §2.8). Never imported by production code (R14). It lives
// in `testing/`, not `ports/fakes/`: it imports kernel values (the identity rule, the invariant
// error), and `ports/` is type-only (05 R2).
//
// The same rules as `SqliteDwarfRepository`: the provider identity is UNIQUE (a second dwarf with
// a bound identity is refused with `HostInvariantError` and changes nothing), `save` runs only
// inside the caller's transaction (the injected `TransactionScope`), and the Host-memory fields
// (`pendingEnd`, `facts.openAsk`) are not stored. Rows are copied in and out, so a caller never
// mutates a stored dwarf. A test's transaction rolls it back with `snapshot` / `restore`.
import { HostInvariantError } from '../../../kernel/domain/errors'
import { sameProviderIdentity } from '../../../kernel/domain/providerIdentity'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { Dwarf } from '../domain/dwarf'
import type { DwarfRepository } from '../ports/dwarfRepository'

export class InMemoryDwarfRepository implements DwarfRepository {
  private stored: Dwarf[] = []

  constructor(private readonly scope: TransactionScope) {}

  byId(id: DwarfId): Dwarf | null {
    return this.copyOf(this.stored.find((d) => d.id === id))
  }

  byProviderIdentity(i: ProviderIdentity): Dwarf | null {
    return this.copyOf(this.stored.find((d) => sameProviderIdentity(d.identity, i)))
  }

  inMine(id: MineId): Dwarf[] {
    return this.stored.filter((d) => d.mineId === id).map((d) => structuredClone(d))
  }

  save(d: Dwarf): void {
    if (!this.scope.isInTransaction()) {
      throw new HostInvariantError(
        'DwarfRepository.save runs inside the caller transaction (16 §2.2)'
      )
    }
    const holder = this.stored.find((s) => sameProviderIdentity(s.identity, d.identity))
    if (holder !== undefined && holder.id !== d.id) {
      throw new HostInvariantError('another dwarf is bound to this provider identity (INV-21)')
    }
    // The Host-memory fields are not stored (09 §4.2 has no column for them).
    const row: Dwarf = { ...structuredClone(d), pendingEnd: null }
    delete row.facts.openAsk
    const at = this.stored.findIndex((s) => s.id === d.id)
    if (at === -1) this.stored.push(row)
    else this.stored[at] = row
  }

  snapshot(): readonly Dwarf[] {
    return [...this.stored]
  }

  restore(snapshot: readonly Dwarf[]): void {
    this.stored = [...snapshot]
  }

  private copyOf(d: Dwarf | undefined): Dwarf | null {
    return d === undefined ? null : structuredClone(d)
  }
}
