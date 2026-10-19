// L8 OS lane (17 §1.8; 07 S3.12, S3.13; ADR-030 item 1, S-030-1; 13 FM-095, FM-096):
// `checkFolder` on the running OS's real disk, through the kernel `NodeFs`, for a mine keyed the
// way the Host's git inspector keys it. The key is case-folded only where the folder folds
// (S-030-1), so the one stat of `checkFolder` must find the folder by that key on every OS: a
// folded key that did not stat would make every mine on a folding volume unenterable. Runs only
// in `pnpm test:os`; one describe per concern, guarded by the OS where the OS decides.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FolderPath } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import { NodeFs } from '../../platform/fs/NodeFs'
import { createHostGitRepoInspector } from './adapters/FsGitRepoInspector'
import { createCheckFolder } from './application/checkFolder'
import type { MinesEvent } from './domain/events'
import { mineIdOf, mineNameOf, openMine, type Mine } from './domain/mine'
import type { MinePath } from './domain/minePath'
import { InMemoryMineRepository } from './testing/InMemoryMineRepository'

const T0 = 1_790_000_000_000

function world() {
  const fs = new NodeFs()
  const clock = new FakeClock(T0)
  let open = false
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      open = true
      try {
        return work()
      } finally {
        open = false
      }
    }
  }
  const scope = { isInTransaction: () => open }
  const repository = new InMemoryMineRepository({ scope, mapSites: [], random: () => 0 })
  const bus = new RecordingEventBus<MinesEvent>({ transactionScope: scope })
  const ids = new SequenceIdGenerator()
  const { checkFolder } = createCheckFolder({
    repository,
    transactions,
    fs,
    clock,
    ids,
    bus,
    hostEpoch: 'epoch-085',
    remeasure: () => undefined
  })
  const inspector = createHostGitRepoInspector({ fs, clock })
  /** A measured, active mine keyed as the Host keys `folder`. */
  const mineAt = async (folder: string): Promise<Mine> => {
    const { mineKey } = await inspector.resolve(folder as FolderPath)
    const born = openMine(
      {
        cause: 'declared',
        birth: {
          id: mineIdOf(ids.uuidv7()),
          path: mineKey as MinePath,
          name: mineNameOf('Old-Shaft')
        }
      },
      T0
    ).mine as Mine
    const mine: Mine = {
      ...born,
      state: 'active',
      tier: 'bronze',
      sourceWeight: { bytes: 1 },
      hasBeenMeasured: true,
      measuredAt: T0
    }
    transactions.inTransaction(() => repository.save(mine))
    return mine
  }
  return { repository, bus, checkFolder, mineAt }
}

let root = ''
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-folder-check-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('checkFolder on the real disk', () => {
  it('[S3.12, S3.13, FM-095, ADR-030] a mine keyed as the Host keys it is enterable while its folder is there, unenterable once it is gone, and enterable again when it is back', async () => {
    const w = world()
    // Mixed case, so the key is folded wherever this temp folder folds (S-030-1).
    const folder = join(root, 'Old-Shaft')
    mkdirSync(folder)
    const mine = await w.mineAt(folder)

    expect(await w.checkFolder(mine.id)).toEqual({ ok: true, value: 'enterable' })
    expect(w.bus.published).toEqual([])

    rmSync(folder, { recursive: true, force: true })
    expect(await w.checkFolder(mine.id)).toEqual({ ok: true, value: 'unenterable' })
    expect(w.repository.byId(mine.id)?.unenterableReason).toBe('not-found')

    mkdirSync(folder)
    expect(await w.checkFolder(mine.id)).toEqual({ ok: true, value: 'enterable' })
    expect(w.bus.published.map((event) => event.type)).toEqual([
      'MineBecameUnenterable',
      'MineBecameEnterable'
    ])
  })
})

// POSIX file modes: a parent folder that cannot be searched makes its child unreachable. Windows
// has no mode bits for this, and root ignores them.
describe.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
  'checkFolder on a POSIX folder that cannot be reached',
  () => {
    it('[FM-096] a folder behind a parent with no search permission is unenterable as access-denied', async () => {
      const w = world()
      const parent = join(root, 'locked')
      const folder = join(parent, 'old-shaft')
      mkdirSync(folder, { recursive: true })
      const mine = await w.mineAt(folder)
      try {
        chmodSync(parent, 0o000)
        expect(await w.checkFolder(mine.id)).toEqual({ ok: true, value: 'unenterable' })
        expect(w.repository.byId(mine.id)?.unenterableReason).toBe('access-denied')
      } finally {
        chmodSync(parent, 0o755)
      }
      // Readable again: found again (S3.13).
      expect(await w.checkFolder(mine.id)).toEqual({ ok: true, value: 'enterable' })
    })
  }
)
