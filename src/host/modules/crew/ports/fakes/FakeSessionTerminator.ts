// The SessionTerminator double (16 §4.2 `FakeSessionTerminator`: a scripted `EndOutcome` per
// dwarf; 16 §2.8). It records every call it receives — dwarf ids, mine ids and reasons only, so
// the contract can prove no call carries a custom name (NFR-PRIV-03) — and never ends anything.
// An unscripted dwarf answers `ended`; `endAll` answers one outcome per dwarf seated in the mine.
// Never imported by production code (R14). Type-only imports (05 R2).
import type { DwarfId, MineId } from '../../../../kernel/domain/values'
import type { EndOutcome, EndReason, SessionTerminator } from '../sessionTerminator'

export type FakeTerminatorCall =
  { method: 'end'; dwarfId: DwarfId; why: EndReason } | { method: 'endAll'; mineId: MineId }

export class FakeSessionTerminator implements SessionTerminator {
  /** Every call received so far, in order. */
  readonly calls: FakeTerminatorCall[] = []
  private readonly outcomes = new Map<DwarfId, EndOutcome>()
  private readonly crews = new Map<MineId, DwarfId[]>()

  /** Makes `dwarfId` one of the present dwarfs `endAll(mineId)` answers for. */
  seat(mineId: MineId, dwarfId: DwarfId): void {
    this.crews.set(mineId, [...(this.crews.get(mineId) ?? []), dwarfId])
  }

  /** What ending `dwarfId` answers from now on. */
  script(dwarfId: DwarfId, outcome: EndOutcome): void {
    this.outcomes.set(dwarfId, outcome)
  }

  end(dwarfId: DwarfId, why: EndReason): Promise<EndOutcome> {
    this.calls.push({ method: 'end', dwarfId, why })
    return Promise.resolve(this.outcomeOf(dwarfId))
  }

  endAll(mineId: MineId): Promise<Map<DwarfId, EndOutcome>> {
    this.calls.push({ method: 'endAll', mineId })
    const crew = this.crews.get(mineId) ?? []
    return Promise.resolve(new Map(crew.map((dwarfId) => [dwarfId, this.outcomeOf(dwarfId)])))
  }

  private outcomeOf(dwarfId: DwarfId): EndOutcome {
    const outcome = this.outcomes.get(dwarfId) ?? { kind: 'ended' }
    return { ...outcome }
  }
}
