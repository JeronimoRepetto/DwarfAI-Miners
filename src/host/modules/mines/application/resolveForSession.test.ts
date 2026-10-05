import { describe, expect, it } from 'vitest'
import type { FolderPath, MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { MinesEvent } from '../domain/events'
import { transition, type Mine } from '../domain/mine'
import { FakeGitRepoInspector } from '../ports/fakes/FakeGitRepoInspector'
import { InMemoryMineRepository } from '../testing/InMemoryMineRepository'
import { createCheckFolder } from './checkFolder'
import type { MinePathProbe } from './resolveFile'
import { createResolveForSession } from './resolveForSession'

// L2 (17 §1.2): `MinesCommands.resolveForSession` (16 §4.1; 06 INV-04, INV-07, INV-39; 07 S3.01,
// S3.02, S3.19; AMENDMENT-2) over the git inspector double, the repository double and a recording
// bus, on synthetic POSIX folders in a FakeFs (privacy-guard).
//
// TC-066-02.
const T0 = 1_790_000_000_000

const at = (path: string) => path as FolderPath

/**
 * `realFolderCheck`: the session's mine is checked on this FakeFs (ISSUE-085); otherwise a stub
 * that finds every folder as the mine's state already says, so the cases above it stay about
 * resolution alone.
 */
function world(opts: { realFolderCheck?: boolean } = {}) {
  const fs = new FakeFs()
  fs.addFile('/work/plain/readme.md', 'plain')
  fs.addFile('/work/repo/.git/HEAD', 'ref: refs/heads/main\n')
  fs.addFile('/work/repo/.git/worktrees/feat/commondir', '../..\n')
  fs.addFile('/work/repo/.git/worktrees/feat/HEAD', 'ref: refs/heads/feat\n')
  fs.addFile('/work/feat/.git', 'gitdir: /work/repo/.git/worktrees/feat\n')

  const clock = new FakeClock(T0)
  let open = false
  const scope = { isInTransaction: () => open }
  const repository = new InMemoryMineRepository({ scope, mapSites: [], random: () => 0 })
  const transactions = {
    inTransaction<T>(work: () => T): T {
      if (open) return work()
      open = true
      try {
        return work()
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<MinesEvent>({ transactionScope: scope })
  const paths: MinePathProbe = {
    realpath: (path) => (fs.entriesNow(path) !== null ? path : null),
    kindOf: (path) => (fs.entriesNow(path) !== null ? 'directory' : null)
  }
  const remeasured: MineId[] = []
  const ids = new SequenceIdGenerator()
  const checked: MineId[] = []
  const real = createCheckFolder({
    repository,
    transactions,
    fs,
    clock,
    ids,
    bus,
    hostEpoch: 'epoch-066',
    remeasure: (mineId) => remeasured.push(mineId)
  })
  const { resolveForSession } = createResolveForSession({
    repository,
    transactions,
    resolver: new FakeGitRepoInspector({ fs, clock, style: 'posix', caseFold: false }),
    paths,
    ids,
    clock,
    bus,
    hostEpoch: 'epoch-066',
    style: 'posix',
    remeasure: (mineId) => remeasured.push(mineId),
    checkFolder: async (mineId) => {
      checked.push(mineId)
      if (opts.realFolderCheck === true) return real.checkFolder(mineId)
      const state = repository.byId(mineId)?.state
      return { ok: true, value: state === 'unenterable' ? 'unenterable' : 'enterable' }
    }
  })
  const save = (mine: Mine) => transactions.inTransaction(() => repository.save(mine))
  return { resolveForSession, repository, bus, remeasured, checked, clock, save, fs }
}

describe('resolveForSession (16 §4.1)', () => {
  it('[INV-39] an unknown folder with no first message answers waiting and writes nothing', async () => {
    const w = world()

    expect(await w.resolveForSession(at('/work/plain'), false)).toEqual({ waiting: true })
    expect(await w.resolveForSession(at('/work/feat'), false)).toEqual({ waiting: true })
    expect(w.repository.snapshot().mines).toEqual([])
    expect(w.bus.published).toEqual([])
    expect(w.remeasured).toEqual([])
  })

  it('[S3.01] the first message creates the mine', async () => {
    const w = world()

    const first = await w.resolveForSession(at('/work/plain'), true)

    expect(first).toEqual({ mineId: expect.any(String), created: true })
    const mineId = (first as { mineId: MineId }).mineId
    expect(w.repository.byId(mineId)).toMatchObject({
      path: '/work/plain',
      name: 'plain',
      state: 'unrecorded',
      tier: null
    })
    expect(w.bus.ofType('MineCreated').map((event) => event.payload)).toEqual([
      { mineId, path: '/work/plain', name: 'plain', origin: 'observed' }
    ])
    expect(w.remeasured).toEqual([mineId])

    // A known folder: the same mine, its recency refreshed, nothing created (INV-02), with or
    // without a first message.
    w.clock.advance(5_000)
    expect(await w.resolveForSession(at('/work/plain'), false)).toEqual({ mineId, created: false })
    expect(w.repository.byId(mineId)?.lastUsedAt).toBe(T0 + 5_000)
    expect(w.bus.published).toHaveLength(1)
  })

  it('[S3.02, S3.19, INV-07] a linked worktree folds onto a new main tree mine, and a removed mine is rediscovered with its id', async () => {
    const w = world()

    const folded = await w.resolveForSession(at('/work/feat'), true)
    expect(folded).toEqual({ mineId: expect.any(String), created: true })
    const repo = (folded as { mineId: MineId }).mineId
    expect(w.repository.byId(repo)).toMatchObject({ path: '/work/repo', state: 'unrecorded' })
    expect(w.bus.ofType('MineCreated').map((event) => event.payload.origin)).toEqual([
      'worktree-fold'
    ])

    const mine = w.repository.byId(repo) as Mine
    const asked = transition(mine, { type: 'removal-requested' }, T0).mine as Mine
    w.save(transition(asked, { type: 'removal-settled', everyDwarfEnded: true }, T0).mine as Mine)

    expect(await w.resolveForSession(at('/work/repo'), false)).toEqual({
      mineId: repo,
      created: false
    })
    expect(w.repository.byId(repo)).toMatchObject({ state: 'unrecorded' })
    expect(w.bus.ofType('MineReattached').map((event) => event.payload)).toEqual([
      { mineId: repo, via: 'rediscovery' }
    ])

    // An unenterable mine answers its reason and gains no dwarf (INV-08).
    const back = w.repository.byId(repo) as Mine
    w.save({ ...back, state: 'unenterable', unenterableReason: 'folder missing' })
    expect(await w.resolveForSession(at('/work/repo'), true)).toEqual({
      unenterable: 'folder missing'
    })
  })

  it('[S3.12, S3.13, INV-08] a session resolving to a known mine checks its folder: gone, it answers the reason; back, the mine is entered again', async () => {
    const w = world({ realFolderCheck: true })
    const first = await w.resolveForSession(at('/work/plain'), true)
    const mineId = (first as { mineId: MineId }).mineId
    // A new mine is not checked: its folder was just resolved.
    expect(w.checked).toEqual([])

    w.fs.removeFile('/work/plain/readme.md')
    expect(await w.resolveForSession(at('/work/plain'), true)).toEqual({ unenterable: 'not-found' })
    expect(w.checked).toEqual([mineId])
    expect(w.repository.byId(mineId)).toMatchObject({
      state: 'unenterable',
      unenterableReason: 'not-found'
    })
    expect(w.bus.ofType('MineBecameUnenterable').map((event) => event.payload)).toEqual([
      { mineId, reason: 'not-found' }
    ])

    w.fs.addFile('/work/plain/readme.md', 'plain')
    expect(await w.resolveForSession(at('/work/plain'), false)).toEqual({ mineId, created: false })
    expect(w.repository.byId(mineId)?.state).toBe('measuring')
    expect(w.bus.ofType('MineBecameEnterable').map((event) => event.payload)).toEqual([{ mineId }])
  })
})
