// The mines module's domain events (08 §0), over the kernel envelope (08 §1.2). Published after
// commit by the use cases (16 §2.3). The measurement events arrive with `remeasure` (later:
// ISSUE-065).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { MineId } from '../../../kernel/domain/values'
import type { MineName } from './mine'
import type { MinePath } from './minePath'

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

export type MinesEvent = MineCreated | MineReattached
