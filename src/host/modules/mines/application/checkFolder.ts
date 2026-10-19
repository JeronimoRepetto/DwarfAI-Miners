// `MinesCommands.checkFolder` (16 §4.1; 05 §3.1 "Folder check", AMENDMENT-2 SC-AR-04; 07 S3.12…
// S3.14; 06 INV-08; 13 FM-095, FM-096; UC-032): whether a mine's folder is still there, and the
// mine's state moved to match, published only on a change.
//
// - One stat of the mine's folder through the kernel `FileSystem`; it never walks the tree (that
//   is `remeasure`). The port's stat answers null for a missing path and for any failure alike,
//   so only then is the folder's own listing read, whose typed cause tells them apart
//   (`domain/folderCheck.ts`): `not-found` and `access-denied` make the folder missing, any other
//   cause proves nothing and leaves the mine as it is (no false unenterable on a transient error).
// - An `unenterable` mine is found again only when its folder can also be listed: a folder that
//   stats but cannot be read (a POSIX mode 000, the walk's S3.11) stays unenterable instead of
//   flapping between S3.13 and S3.11 on every check.
// - Missing on an `unrecorded` or `active` mine → `unenterable` with the reason, its tier, weight
//   and ledger kept, never removed (S3.12, `MineBecameUnenterable`). A `measuring` mine is left to
//   its walk, which ends in S3.11 for the same folder: 07 lists S3.12 from `unrecorded`/`active`
//   only, and 07 owns machine 3 (16 §4.1 also names `measuring`; reported in the ISSUE-085 hand-off).
// - Found again on an `unenterable` mine → `active` if measured before (S3.13), else `measuring`
//   (S3.14), `MineBecameEnterable`, and a re-measurement is queued through `remeasure`, whose walk
//   publishes `MineMeasurementStarted` (S3.10 for an active mine, the walk start for a measuring
//   one).
// - A removed or absent mine is `'unknown-mine'`. The answer is the mine's enterability after the
//   check.
// - Concurrent checks of one mine are serialized: a check asked while one runs waits for it and
//   then reads the folder again, and every further ask in the meantime shares that one follow-up,
//   so one mine never has two reads in flight nor a growing queue. The reads run with no
//   transaction open; the state is re-read and saved in one transaction (16 §2.2), and the event
//   is published after it commits (16 §2.3).
import type { EventId, HostEpoch, MineId, Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { FolderCheckEvent } from '../domain/events'
import { findingOfListing, findingOfStat, type FolderFinding } from '../domain/folderCheck'
import { transition, type Mine, type MineInput, type MineStep } from '../domain/mine'
import type { MineRepository } from '../ports/mineRepository'
import type { MinesCommands } from './declare'

export interface CheckFolderDeps {
  readonly repository: MineRepository
  readonly transactions: TransactionRunner
  /** Read only: one stat, and the folder's listing only when the stat cannot tell. */
  readonly fs: Pick<FileSystem, 'stat' | 'listDirWithSizes'>
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly bus: Pick<DomainEventBus<FolderCheckEvent>, 'publish'>
  readonly hostEpoch: HostEpoch
  /** `MinesCommands.remeasure`: the walk queued for a mine found again (S3.13, S3.14). */
  remeasure(mineId: MineId): void
}

type Answer = Result<'enterable' | 'unenterable', 'unknown-mine'>

/** `checkFolder` over `deps`, with its per-mine serialization. */
export function createCheckFolder(deps: CheckFolderDeps): Pick<MinesCommands, 'checkFolder'> {
  /** The check of each mine that is reading or writing now. */
  const running = new Map<MineId, Promise<Answer>>()
  /** The one follow-up check of each mine, waiting for the running one. */
  const waiting = new Map<MineId, Promise<Answer>>()

  const start = (mineId: MineId): Promise<Answer> => {
    const run = checkOnce(deps, mineId).finally(() => {
      if (running.get(mineId) === run) running.delete(mineId)
    })
    running.set(mineId, run)
    return run
  }

  return {
    checkFolder(mineId) {
      const queued = waiting.get(mineId)
      if (queued !== undefined) return queued
      const current = running.get(mineId)
      if (current === undefined) return start(mineId)
      const next = current
        .then(
          () => undefined,
          () => undefined
        )
        .then(() => {
          waiting.delete(mineId)
          return start(mineId)
        })
      waiting.set(mineId, next)
      return next
    }
  }
}

/** One check of one mine: read the folder, then move the mine if the finding changes its state. */
async function checkOnce(deps: CheckFolderDeps, mineId: MineId): Promise<Answer> {
  const before = deps.repository.byId(mineId)
  if (before === null || before.state === 'removed') return { ok: false, error: 'unknown-mine' }
  const finding = await folderFinding(deps, before)
  const input = inputOf(finding)
  const now = deps.clock.now()
  const step = deps.transactions.inTransaction((): MineStep | null => {
    const mine = deps.repository.byId(mineId)
    if (mine === null || mine.state === 'removed') return null
    if (input === null) return { mine, transition: null }
    const next = transition(mine, input, now)
    if (next.mine !== null && next.transition !== null) deps.repository.save(next.mine)
    return next
  })
  if (step === null || step.mine === null) return { ok: false, error: 'unknown-mine' }
  const mine = step.mine
  if (step.transition === 'S3.12') {
    publish(deps, {
      type: 'MineBecameUnenterable',
      payload: { mineId, reason: mine.unenterableReason ?? '' }
    })
  } else if (step.transition === 'S3.13' || step.transition === 'S3.14') {
    publish(deps, { type: 'MineBecameEnterable', payload: { mineId } })
    deps.remeasure(mineId)
  }
  return { ok: true, value: mine.state === 'unenterable' ? 'unenterable' : 'enterable' }
}

/** What the disk says about the mine's folder; a read that throws proves nothing. */
async function folderFinding(deps: CheckFolderDeps, mine: Mine): Promise<FolderFinding> {
  const path = mine.path as string
  try {
    const stat = findingOfStat(await deps.fs.stat(path))
    // A folder that stats is enough, unless the mine waits to be found again: then it must read.
    if (stat !== 'ask-listing' && (stat.folder !== 'present' || mine.state !== 'unenterable')) {
      return stat
    }
    const listing = await deps.fs.listDirWithSizes(path)
    return findingOfListing(listing.ok ? null : listing.error)
  } catch {
    return { folder: 'unknown' }
  }
}

function inputOf(finding: FolderFinding): MineInput | null {
  switch (finding.folder) {
    case 'present':
      return { type: 'folder-checked', folder: 'present' }
    case 'missing':
      return { type: 'folder-checked', folder: 'missing', reason: finding.reason }
    default:
      return null
  }
}

function publish(deps: CheckFolderDeps, event: Pick<FolderCheckEvent, 'type' | 'payload'>): void {
  deps.bus.publish({
    ...event,
    v: 1,
    id: deps.ids.uuidv7() as EventId,
    at: deps.clock.now(),
    hostEpoch: deps.hostEpoch
  } as FolderCheckEvent)
}
