// `CrewCommands.rename` and `resetName` (05 §3.2; 16 §4.2 row `rename` / `resetName`; AMENDMENT-2,
// SC-AR-05; UC-034), served by `CrewArrivals` over its deps.
//
// - `rename` stores the text's `DwarfName` (06 §5.1, INV-29: trimmed, collapsed, no emoji or control
//   characters, 1..24 grapheme clusters) as `dwarfs.custom_name`. Nothing left of the text is the
//   `'empty'` outcome and stores nothing; a text equal to `baseName` after normalization is a
//   `resetName`, answered `null`. Duplicates across dwarfs are allowed (US-MSG-005.AC09).
// - Each command runs in one synchronous transaction (16 §2.2) and publishes `DwarfRenamed` after
//   the commit, only when the custom name changed (08 §0 "on change").
// - A departed dwarf keeps its custom name on its past turns (US-MSG-005.AC13); a rename or a reset
//   that reaches it afterwards is a race, a silent no-op (16 §2.1). A dwarf id that never existed and
//   a name above 24 grapheme clusters are programming errors (`HostInvariantError`): UI main and the
//   transport refuse both first (crewRename.ts), and neither message carries the name.
// - The custom name is display only: crew never sends it to a provider and never logs it
//   (NFR-PRIV-03, NFR-SEC-12); the base name stays the agent-facing one.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, EventId, HostEpoch, Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { Dwarf } from '../domain/dwarf'
import { normalizeDwarfName } from '../domain/dwarfName'
import type { CrewEvent } from '../domain/events'
import { isGone } from '../domain/presence'
import type { DwarfRepository } from '../ports/dwarfRepository'

export interface CrewRenamesDeps {
  repository: DwarfRepository
  transactions: TransactionRunner
  bus: Pick<DomainEventBus<CrewEvent>, 'publish'>
  clock: Clock
  ids: IdGenerator
  /** This boot's epoch, carried by every event (ADR-015). */
  hostEpoch: HostEpoch
}

export class CrewRenames {
  constructor(private readonly deps: CrewRenamesDeps) {}

  rename(dwarfId: DwarfId, text: string): Result<string | null, 'empty'> {
    const normalized = normalizeDwarfName(text)
    if (!normalized.ok) {
      throw new HostInvariantError('a custom name above 24 grapheme clusters reached crew')
    }
    const { name } = normalized.value
    const outcome = this.deps.transactions.inTransaction(
      (): { answer: Result<string | null, 'empty'>; changed: boolean } => {
        const dwarf = this.existing(dwarfId)
        if (isGone(dwarf)) return { answer: { ok: true, value: dwarf.customName }, changed: false }
        if (name === '') return { answer: { ok: false, error: 'empty' }, changed: false }
        const customName = name === dwarf.baseName.normalize('NFC') ? null : name
        return { answer: { ok: true, value: customName }, changed: this.store(dwarf, customName) }
      }
    )
    if (outcome.changed && outcome.answer.ok) this.published(dwarfId, outcome.answer.value)
    return outcome.answer
  }

  resetName(dwarfId: DwarfId): void {
    const changed = this.deps.transactions.inTransaction(() => {
      const dwarf = this.existing(dwarfId)
      return !isGone(dwarf) && this.store(dwarf, null)
    })
    if (changed) this.published(dwarfId, null)
  }

  /** Saves `customName` on `dwarf` when it differs; whether it did. */
  private store(dwarf: Dwarf, customName: string | null): boolean {
    if (dwarf.customName === customName) return false
    this.deps.repository.save({ ...dwarf, customName })
    return true
  }

  private existing(dwarfId: DwarfId): Dwarf {
    const dwarf = this.deps.repository.byId(dwarfId)
    if (dwarf === null) throw new HostInvariantError(`no dwarf ${dwarfId} was ever stored`)
    return dwarf
  }

  private published(dwarfId: DwarfId, customName: string | null): void {
    const { bus, ids, clock, hostEpoch } = this.deps
    bus.publish({
      type: 'DwarfRenamed',
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload: { dwarfId, customName }
    })
  }
}
