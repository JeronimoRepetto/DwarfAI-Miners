// The events of Remove mine (08 §0, §2.1; 16 §4.1 `MinesCommands.remove`; 07 S3.16, S3.17), over the
// kernel envelope (08 §1.2), and `MinesEvent`, every event the mines module publishes. The other
// events are `domain/events.ts`'s; these two are the outcome of a command that waits on crew's ends
// (an outside step, 16 §2.2), so they sit with that use case. Each is published after its commit,
// or after the settled ends when nothing is written (16 §2.3).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import type { MinesEvent as MineLifecycleEvent } from '../domain/events'

/**
 * Every dwarf ended and the mine is `removed`, its ledger kept (08 §0; S3.16; INV-06, INV-96). State,
 * keyed `(mineId, removedAt)`: `mine.removed` takes its marker and its ore off the board.
 */
export type MineRemoved = DomainEvent<'MineRemoved', { mineId: MineId; removedAt: Instant }>

/**
 * One or more dwarfs could not be ended, so the mine stays with them (08 §0; S3.17; ADR-014 item 6):
 * the ONLY message of a partial Remove mine, one danger toast naming every failed dwarf (PO #79).
 */
export type MineRemovalFailed = DomainEvent<
  'MineRemovalFailed',
  { mineId: MineId; requestId: string; failed: DwarfId[] }
>

/** The events of `MinesCommands.remove`. */
export type MineRemovalEvent = MineRemoved | MineRemovalFailed

/** Every event the mines module publishes so far. */
export type MinesEvent = MineLifecycleEvent | MineRemovalEvent
