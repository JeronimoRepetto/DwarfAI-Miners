// The `CrewQueries` driving port (05 §3.2; 16 §4.2): read models over `DwarfRepository`, with the
// status and the other derived fields read at the clock's now (06 §5.1 `DwarfView`). Read-only:
// no transaction, no event. The strangler-only `presentIdentities` joins with ISSUE-083.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { Dwarf } from '../domain/dwarf'
import { displayNameOf, viewOf, type DwarfView } from '../domain/dwarfView'
import { isGone } from '../domain/presence'
import type { DwarfRepository } from '../ports/dwarfRepository'

export interface CrewQueries {
  /** The present crew by default; `includeDeparted` adds the dwarfs that left, each marked departed (AMENDMENT-10). */
  crewOf(mineId: MineId, opts?: { includeDeparted?: boolean }): DwarfView[]
  /** Incl. the derived `needsYou`, `canReceiveMessages`, `stopUnavailableReason` and `owned`. */
  get(dwarfId: DwarfId): DwarfView | null
  /** `customName ?? baseName` (OQ-27, INV-104 titles); never sent to a provider (NFR-PRIV-03). */
  displayName(dwarfId: DwarfId): string
}

/**
 * What crew reads about a dwarf's sessions from the modules that own them, bound by `host/wiring`
 * (crew imports only suppliers, 05 §1.3): `owned` iff launching holds a live `LaunchRecord` for
 * it (INV-30: never a `Dwarf` field), and whether a delivery route exists (a driver session or an
 * observed relay, INV-33).
 */
export interface SessionLinks {
  owned(dwarfId: DwarfId): boolean
  hasDeliveryRoute(dwarfId: DwarfId): boolean
}

export interface CrewReadModelDeps {
  repository: DwarfRepository
  clock: Clock
  links: SessionLinks
}

export class CrewReadModel implements CrewQueries {
  constructor(private readonly deps: CrewReadModelDeps) {}

  crewOf(mineId: MineId, opts: { includeDeparted?: boolean } = {}): DwarfView[] {
    const now = this.deps.clock.now()
    return this.deps.repository
      .inMine(mineId)
      .filter((d) => opts.includeDeparted === true || !isGone(d))
      .map((d) => this.view(d, now))
  }

  get(dwarfId: DwarfId): DwarfView | null {
    const dwarf = this.deps.repository.byId(dwarfId)
    return dwarf === null ? null : this.view(dwarf, this.deps.clock.now())
  }

  displayName(dwarfId: DwarfId): string {
    const dwarf = this.deps.repository.byId(dwarfId)
    if (dwarf === null) throw new HostInvariantError(`no dwarf ${dwarfId} was ever stored`)
    return displayNameOf(dwarf)
  }

  private view(d: Dwarf, now: number): DwarfView {
    const { links } = this.deps
    return viewOf(d, now, {
      owned: links.owned(d.id),
      hasDeliveryRoute: links.hasDeliveryRoute(d.id)
    })
  }
}
