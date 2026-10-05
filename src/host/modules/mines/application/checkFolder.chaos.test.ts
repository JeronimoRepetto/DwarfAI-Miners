// L10 (17 §1.10): `MinesCommands.checkFolder` under a faulty file system (13 FM-095, FM-096; 07
// S3.12…S3.14; CH-07 `EBUSY`, `EPERM`, `EACCES`). Faults are scripted per path on the FakeFs
// (the kernel double's chaos injector), and a read that rejects outright is a wrapper below.
// Deterministic: a fake clock, no real disk and no timer.
import { describe, expect, it } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { MinesEvent } from '../domain/events'
import { mineIdOf, mineNameOf, openMine, type Mine } from '../domain/mine'
import { canonicalMinePath } from '../domain/minePath'
import { InMemoryMineRepository } from '../testing/InMemoryMineRepository'
import { createCheckFolder } from './checkFolder'

const T0 = 1_790_000_000_000

type FolderReads = Pick<FileSystem, 'stat' | 'listDirWithSizes'>

/** Every read of `path` rejects, as a driver or an antivirus hook failing mid-call might. */
function throwingAt(fs: FakeFs, path: string): FolderReads {
  const fail = (at: string) => {
    if (at === path) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
  }
  return {
    stat: async (at) => (fail(at), fs.stat(at)),
    listDirWithSizes: async (at) => (fail(at), fs.listDirWithSizes(at))
  }
}

function world(reads?: (fs: FakeFs) => FolderReads) {
  const fs = new FakeFs()
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
  const remeasured: MineId[] = []
  const lazyReads: FolderReads = {
    stat: (path) => (reads?.(fs) ?? fs).stat(path),
    listDirWithSizes: (path) => (reads?.(fs) ?? fs).listDirWithSizes(path)
  }
  const { checkFolder } = createCheckFolder({
    repository,
    transactions,
    fs: lazyReads,
    clock,
    ids,
    bus,
    hostEpoch: 'epoch-085',
    remeasure: (mineId) => remeasured.push(mineId)
  })
  /** A measured mine at `/work/<name>`, stored in `state`, its folder holding one file. */
  const mine = (name: string, state: 'active' | 'unenterable' = 'active'): Mine => {
    fs.addFile(`/work/${name}/main.ts`, 'export const ore = 1\n')
    const born = openMine(
      {
        cause: 'declared',
        birth: {
          id: mineIdOf(ids.uuidv7()),
          path: canonicalMinePath(`/work/${name}`, { style: 'posix', caseFold: false }),
          name: mineNameOf(name)
        }
      },
      T0
    ).mine as Mine
    const stored: Mine = {
      ...born,
      state,
      tier: 'gold',
      sourceWeight: { bytes: 65_536 },
      hasBeenMeasured: true,
      measuredAt: T0,
      ...(state === 'unenterable' ? { unenterableReason: 'access-denied' } : {})
    }
    transactions.inTransaction(() => repository.save(stored))
    return stored
  }
  return { fs, repository, bus, remeasured, checkFolder, mine }
}

describe('checkFolder under a faulty file system (13 FM-096)', () => {
  it('[FM-096] an unreadable folder yields unenterable with its reason and never throws', async () => {
    const w = world()
    const denied = w.mine('denied')
    const forbidden = w.mine('forbidden')
    w.fs.scriptFault(denied.path, 'EACCES')
    w.fs.scriptFault(forbidden.path, 'EPERM')

    await expect(w.checkFolder(denied.id)).resolves.toEqual({ ok: true, value: 'unenterable' })
    await expect(w.checkFolder(forbidden.id)).resolves.toEqual({ ok: true, value: 'unenterable' })

    expect(w.repository.byId(denied.id)).toEqual({
      ...denied,
      state: 'unenterable',
      unenterableReason: 'access-denied'
    })
    expect(w.repository.byId(forbidden.id)?.unenterableReason).toBe('access-denied')
    expect(w.bus.ofType('MineBecameUnenterable').map((event) => event.payload)).toEqual([
      { mineId: denied.id, reason: 'access-denied' },
      { mineId: forbidden.id, reason: 'access-denied' }
    ])
  })

  it('[S3.12, FM-096] a transient failure or a read that throws proves nothing: the mine stays as it was and nothing is published', async () => {
    const busy = world()
    const locked = busy.mine('locked')
    busy.fs.scriptFault(locked.path, 'EBUSY')
    await expect(busy.checkFolder(locked.id)).resolves.toEqual({ ok: true, value: 'enterable' })
    expect(busy.repository.byId(locked.id)).toEqual(locked)
    expect(busy.bus.published).toEqual([])

    const flaky = world((fs) => throwingAt(fs, '/work/flaky'))
    const shaft = flaky.mine('flaky')
    const away = flaky.mine('away', 'unenterable')
    await expect(flaky.checkFolder(shaft.id)).resolves.toEqual({ ok: true, value: 'enterable' })
    expect(flaky.repository.byId(shaft.id)).toEqual(shaft)
    expect(flaky.bus.published).toEqual([])
    // A failing read never finds an unenterable mine again either.
    flaky.fs.scriptFault(away.path, 'EBUSY')
    await expect(flaky.checkFolder(away.id)).resolves.toEqual({ ok: true, value: 'unenterable' })
    expect(flaky.repository.byId(away.id)).toEqual(away)
    expect(flaky.remeasured).toEqual([])
  })

  it('[S3.13, FM-096] a folder that stats but cannot be listed stays unenterable, and is found again once it reads', async () => {
    const statsOnly = (fs: FakeFs): FolderReads => ({
      stat: (path) => fs.stat(path),
      listDirWithSizes: async (path) =>
        path === '/work/sealed' ? { ok: false, error: 'access-denied' } : fs.listDirWithSizes(path)
    })
    const w = world(statsOnly)
    const sealed = w.mine('sealed', 'unenterable')

    await expect(w.checkFolder(sealed.id)).resolves.toEqual({ ok: true, value: 'unenterable' })
    expect(w.repository.byId(sealed.id)).toEqual(sealed)
    expect(w.bus.published).toEqual([])
    expect(w.remeasured).toEqual([])

    const open = w.mine('open', 'unenterable')
    await expect(w.checkFolder(open.id)).resolves.toEqual({ ok: true, value: 'enterable' })
    expect(w.repository.byId(open.id)?.state).toBe('active')
    expect(w.bus.published.map((event) => event.type)).toEqual(['MineBecameEnterable'])
    expect(w.remeasured).toEqual([open.id])
  })
})
