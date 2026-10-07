// `MinesCommands.declare` and `adoptMainProject` (05 §3.1, 16 §4.1; UC-039; 07 S3.04…S3.07,
// S3.20, S3.21; ADR-030 items 1–2; ADR-019 item 9): "Add a mine" and the worktree dialog.
//
// - The path comes from UI main's folder picker and is re-validated here (14 §1.10; 18 C-17): an
//   absolute path with no NUL, and on Windows no UNC or device path (no network connection is
//   opened for it), else `invalid-path`; its OS realpath must exist and be a folder, else
//   `not-a-folder`. Everything after uses the real path.
// - The identity is the exact folder (ADR-030 item 1): `MineIdentityResolver` never walks up, except
//   from a linked worktree to its main working tree (item 2). A linked worktree is never declared:
//   `declare` answers `{ worktreeOf, mainPath }` and writes nothing, so the UI asks the PO #41
//   question. `mainPath` is the main working tree's key the resolver found, whether or not it is a
//   mine yet (owner amendment G, 2026-10-07): the dialog names it. When the main tree has no mine
//   yet, `worktreeOf` is a fresh id from the `IdGenerator` that names no stored mine (UC-039 "mineId
//   of T (or of a new main tree)"): UI main never resolves it, it only remembers the worktree path
//   for A-31, and `adoptMainProject` answers the real id.
// - A folder that never was a mine becomes `measuring` (S3.04, INV-04); a removed one is reattached
//   with its id and ledger (S3.20 measured → `active`, S3.21 → `measuring`; INV-07); a live one is
//   answered as is (UNIQUE `canonical_path`: a second declare returns the same `mineId`). The
//   lookup and the write share one transaction; the resolver's I/O runs before it.
// - `adoptMainProject` declares the main working tree of a linked worktree (S3.05, origin
//   `worktree-fold`) or answers its existing mine (S3.06); a folder that is not a linked worktree
//   has no main project (`no-main-project`, S3.07).
// - Events are published after commit (16 §2.3): `MineCreated` or `MineReattached{manual-add}`.
//   A created or reattached mine is handed to `remeasure`, whose walk publishes
//   `MineMeasurementStarted` (later: ISSUE-065).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { EventId, FolderPath, HostEpoch, MineId, Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { MinesEvent } from '../domain/events'
import {
  mineIdOf,
  mineNameOf,
  openMine,
  transition,
  type Mine,
  type MineInput,
  type MineName,
  type MineStep
} from '../domain/mine'
import { isAbsolutePath, type MinePath, type PathStyle } from '../domain/minePath'
import type { MineIdentityResolver } from '../ports/mineIdentityResolver'
import type { MineRepository } from '../ports/mineRepository'
import type { MinePathProbe } from './resolveFile'

// verbatim: 05 §3.1 (16 §4.1) `MinesCommands`
export interface MinesCommands {
  resolveForSession(
    path: FolderPath,
    firstMessage: boolean
  ): Promise<{ mineId: MineId; created: boolean } | { unenterable: string } | { waiting: true }> // { waiting }: unknown folder, no first message yet → no mine, no dwarf, cursor only (06 INV-39; AMENDMENT-2, SC-AR-01)
  declare(
    path: FolderPath
  ): Promise<
    Result<
      { mineId: MineId } | { worktreeOf: MineId; mainPath: FolderPath },
      'not-a-folder' | 'invalid-path'
    >
  > // Amended: mainPath (owner amendment G, 2026-10-07)
  adoptMainProject(worktreePath: FolderPath): Promise<Result<{ mineId: MineId }, 'no-main-project'>>
  remove(mineId: MineId, requestId: string): Promise<Result<void, 'dwarf-could-not-be-ended'>> // OQ-06, OQ-11: keeps the mine on failure; requestId → MineRemovalFailed (08 §0)
  remeasure(mineId: MineId): void
  checkFolder(mineId: MineId): Promise<Result<'enterable' | 'unenterable', 'unknown-mine'>> // 07 S3.12/S3.13 (AMENDMENT-2, SC-AR-04): publishes MineBecameUnenterable / MineBecameEnterable only on a change
}
// end verbatim

/** What the mines commands of this file and `resolveForSession.ts` run on. */
export interface MineCommandDeps {
  readonly repository: MineRepository
  readonly transactions: TransactionRunner
  readonly resolver: MineIdentityResolver
  /** The OS's answers about a path (`adapters/pathValidation.ts`). */
  readonly paths: MinePathProbe
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly bus: DomainEventBus<MinesEvent>
  readonly hostEpoch: HostEpoch
  /** The Host's path rules (`volumeCase.ts`). */
  readonly style: PathStyle
  /** `MinesCommands.remeasure`: starts the walk of a created or reattached mine (ISSUE-065). */
  remeasure(mineId: MineId): void
}

/** `declare` and `adoptMainProject` over `deps`. */
export function createDeclareCommands(
  deps: MineCommandDeps
): Pick<MinesCommands, 'declare' | 'adoptMainProject'> {
  return {
    async declare(path) {
      const real = revalidated(deps, path)
      if (!real.ok) return real
      const { mineKey, workplace } = await deps.resolver.resolve(real.value)
      if (workplace !== undefined) {
        const main = deps.repository.byPath(mineKey as FolderPath)
        return {
          ok: true,
          value: {
            worktreeOf: main?.id ?? mineIdOf(deps.ids.uuidv7()),
            mainPath: mineKey as FolderPath
          }
        }
      }
      const mineId = settle(deps, mineKey as MinePath, 'declared')
      return { ok: true, value: { mineId } }
    },

    async adoptMainProject(worktreePath) {
      const real = revalidated(deps, worktreePath)
      if (!real.ok) return { ok: false, error: 'no-main-project' }
      const { mineKey, workplace } = await deps.resolver.resolve(real.value)
      if (workplace === undefined) return { ok: false, error: 'no-main-project' }
      return { ok: true, value: { mineId: settle(deps, mineKey as MinePath, 'adopted') } }
    }
  }
}

/** The folder's real path, or why the Host refuses it (18 C-17; 14 §1.10). */
function revalidated(
  deps: MineCommandDeps,
  path: string
): Result<string, 'not-a-folder' | 'invalid-path'> {
  if (path.includes('\0') || !isAbsolutePath(path, deps.style)) {
    return { ok: false, error: 'invalid-path' }
  }
  if (deps.style === 'win32' && /^[\\/]{2}/.test(path)) return { ok: false, error: 'invalid-path' }
  const real = deps.paths.realpath(path)
  if (real === null || deps.paths.kindOf(real) !== 'directory') {
    return { ok: false, error: 'not-a-folder' }
  }
  return { ok: true, value: real }
}

/** The mine at `key` after a declaration or an adoption: created, reattached or as it was. */
function settle(deps: MineCommandDeps, key: MinePath, how: 'declared' | 'adopted'): MineId {
  const name = nameOfFolder(deps, key)
  const now = deps.clock.now()
  const input: MineInput = { type: how === 'declared' ? 'declared' : 'main-project-adopted' }
  const outcome = deps.transactions.inTransaction(() => {
    const existing = deps.repository.byPath(key as string as FolderPath)
    const step: MineStep =
      existing === null
        ? openMine(
            {
              cause: how === 'declared' ? 'declared' : 'adopted-main-project',
              birth: { id: mineIdOf(deps.ids.uuidv7()), path: key, name }
            },
            now
          )
        : transition(existing, input, now)
    const mine = mineOf(step)
    const changed = existing === null || step.transition === 'S3.20' || step.transition === 'S3.21'
    if (changed) deps.repository.save(mine)
    return { mine, created: existing === null, reattached: existing !== null && changed }
  })
  if (outcome.created) {
    publishCreated(deps, outcome.mine, how === 'declared' ? 'declared' : 'worktree-fold')
  }
  if (outcome.reattached) publishReattached(deps, outcome.mine.id, 'manual-add')
  if (outcome.created || outcome.reattached) deps.remeasure(outcome.mine.id)
  return outcome.mine.id
}

/** The mine a step leaves; a declaration step always leaves one. */
export function mineOf(step: MineStep): Mine {
  if (step.mine === null) throw new HostInvariantError('a mine opening left no mine')
  return step.mine
}

/**
 * A mine's display name: the base name of its folder as the disk spells it. The key may be
 * case-folded (ADR-030 item 1), so the folder's realpath gives the spelling when it can.
 */
export function nameOfFolder(
  deps: Pick<MineCommandDeps, 'paths' | 'style'>,
  key: MinePath
): MineName {
  const spelled = deps.paths.realpath(key) ?? key
  const separators = deps.style === 'win32' ? /[\\/]+/ : /\/+/
  const segments = spelled.split(separators).filter((segment) => segment !== '')
  return mineNameOf(segments.at(-1) ?? spelled)
}

export function publishCreated(
  deps: MineCommandDeps,
  mine: Mine,
  origin: 'observed' | 'declared' | 'worktree-fold'
): void {
  deps.bus.publish({
    type: 'MineCreated',
    v: 1,
    id: deps.ids.uuidv7() as EventId,
    at: deps.clock.now(),
    hostEpoch: deps.hostEpoch,
    payload: { mineId: mine.id, path: mine.path, name: mine.name, origin }
  })
}

export function publishReattached(
  deps: MineCommandDeps,
  mineId: MineId,
  via: 'rediscovery' | 'manual-add'
): void {
  deps.bus.publish({
    type: 'MineReattached',
    v: 1,
    id: deps.ids.uuidv7() as EventId,
    at: deps.clock.now(),
    hostEpoch: deps.hostEpoch,
    payload: { mineId, via }
  })
}
