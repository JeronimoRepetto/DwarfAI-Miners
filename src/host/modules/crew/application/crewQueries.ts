// The `CrewQueries` driving port (05 §3.2; 16 §4.2): read models over `DwarfRepository`, with the
// status and the other derived fields read at the clock's now (06 §5.1 `DwarfView`). Read-only:
// no transaction, no event.
//
// Strangler-only (05 §3.2; 14 B-M41; AMENDMENT-8, OQ-69): `presentIdentities` and the
// `PresentDwarfs` read behind it. Their only caller is the B-M41 `strangler.dwarfIdentities`
// handler (host/transport/methods/strangler.ts), read by `LegacyDwarfIdBridge`; they never feed a
// renderer read model and are deleted together with B-M41 at the end of cut 4 (later: ISSUE-241).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, MineId, ProviderId, ProviderIdentity } from '../../../kernel/domain/values'
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
  /** Strangler-only (05 §3.2): one record per present dwarf, `providerId = identity.providerId`, imported names only. */
  presentIdentities(): { dwarfId: DwarfId; providerId: ProviderId; identity: ProviderIdentity }[]
}

/** One record of `presentIdentities` (strangler-only; deleted with B-M41 at the end of cut 4). */
export type PresentIdentity = ReturnType<CrewQueries['presentIdentities']>[number]

/**
 * Strangler-only: every present dwarf of every mine, in arrival order. The frozen
 * `DwarfRepository` (16 §4.2) lists dwarfs per mine only, so this read sits beside it, implemented
 * by the same adapter and its double, and is deleted with B-M41 at the end of cut 4.
 */
export interface PresentDwarfs {
  present(): Dwarf[]
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
  /** Strangler-only, for `presentIdentities` (deleted with B-M41 at the end of cut 4). */
  presentDwarfs: PresentDwarfs
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

  presentIdentities(): PresentIdentity[] {
    return this.deps.presentDwarfs.present().map((d) => ({
      dwarfId: d.id,
      providerId: d.identity.providerId,
      identity: { ...d.identity }
    }))
  }

  private view(d: Dwarf, now: number): DwarfView {
    const { links } = this.deps
    return viewOf(d, now, {
      owned: links.owned(d.id),
      hasDeliveryRoute: links.hasDeliveryRoute(d.id)
    })
  }
}
