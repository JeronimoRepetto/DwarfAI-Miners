// The mines module's domain events (08 §0), over the kernel envelope (08 §1.2). Published after
// commit by the use cases (16 §2.3).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { Instant, MineId } from '../../../kernel/domain/values'
import type { MineName } from './mine'
import type { MinePath } from './minePath'
import type { SourceWeight, Tier } from './tier'

/**
 * A mine came to exist (08 §0; 07 S3.01, S3.02, S3.04, S3.05): `observed` on a session's first
 * message, `declared` by "Add a mine", `worktree-fold` for a main working tree reached through one
 * of its linked worktrees (observed, or adopted in the worktree dialog). State, keyed by `path`.
 */
export type MineCreated = DomainEvent<
  'MineCreated',
  {
    mineId: MineId
    path: MinePath
    name: MineName
    origin: 'observed' | 'declared' | 'worktree-fold'
  }
>

/**
 * A removed mine is back with its id and ledger (08 §0; INV-07; 07 S3.19, S3.20, S3.21):
 * `rediscovery` by an observed session, `manual-add` by "Add a mine" or the worktree dialog.
 */
export type MineReattached = DomainEvent<
  'MineReattached',
  { mineId: MineId; via: 'rediscovery' | 'manual-add' }
>

/** A scoring walk started (08 §0; 07 S3.04, S3.08, S3.10). State, keyed `(mineId, startedAt)`. */
export type MineMeasurementStarted = DomainEvent<
  'MineMeasurementStarted',
  { mineId: MineId; startedAt: Instant }
>

/**
 * A walk finished and set the tier from the measured weight (08 §0; 07 S3.09; INV-05). State,
 * keyed `(mineId, measuredAt)`; the ledger credits a never-measured mine's sealed units (INV-94).
 */
export type MineMeasured = DomainEvent<
  'MineMeasured',
  { mineId: MineId; tier: Tier; sourceWeight: SourceWeight; measuredAt: Instant }
>

/** The mine's folder is missing or unreadable (08 §0; 07 S3.11, S3.12). State, on change. */
export type MineBecameUnenterable = DomainEvent<
  'MineBecameUnenterable',
  { mineId: MineId; reason: string }
>

/** The mine's folder is found again (08 §0; 07 S3.13, S3.14). State, on change. */
export type MineBecameEnterable = DomainEvent<'MineBecameEnterable', { mineId: MineId }>

/** The events of the scoring walk (`MinesCommands.remeasure`, ISSUE-065). */
export type MeasurementEvent = MineMeasurementStarted | MineMeasured | MineBecameUnenterable

/** The events of the folder check (`MinesCommands.checkFolder`, ISSUE-085). */
export type FolderCheckEvent = MineBecameUnenterable | MineBecameEnterable

export type MinesEvent = MineCreated | MineReattached | MeasurementEvent | MineBecameEnterable
