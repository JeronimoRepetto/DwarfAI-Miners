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
import { createDeclareCommands } from './declare'
import type { MinePathProbe } from './resolveFile'

// L2 (17 §1.2): "Add a mine" and the worktree dialog (16 §4.1 `declare`, `adoptMainProject`;
// UC-039; 07 S3.04…S3.07, S3.20, S3.21; ADR-030 items 1–2) over the git inspector double, the
// repository double and a recording bus. The folders live in a FakeFs (synthetic POSIX roots,
// privacy-guard); the path probe reads the same FakeFs.
//
// TC-066-01.
const T0 = 1_790_000_000_000
const SITE = { xPct: 10, yPct: 20 }

const at = (path: string) => path as FolderPath

function world() {
  const fs = new FakeFs()
  // A plain folder, a main working tree and one of its linked worktrees (ADR-030 item 2).
  fs.addFile('/work/plain/readme.md', 'plain')
  fs.addFile('/work/repo/.git/HEAD', 'ref: refs/heads/main\n')
  fs.addFile('/work/repo/.git/worktrees/feat/commondir', '../..\n')
  fs.addFile('/work/repo/.git/worktrees/feat/HEAD', 'ref: refs/heads/feat\n')
  fs.addFile('/work/feat/.git', 'gitdir: /work/repo/.git/worktrees/feat\n')

  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  let open = false
  const scope = { isInTransaction: () => open }
  const repository = new InMemoryMineRepository({ scope, mapSites: [SITE], random: () => 0 })
  const transactions = {
    inTransaction<T>(work: () => T): T {
      if (open) return work()
      open = true
      const before = repository.snapshot()
      try {
        return work()
      } catch (error) {
        repository.restore(before)
        throw error
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<MinesEvent>({ transactionScope: scope })
  const resolver = new FakeGitRepoInspector({ fs, clock, style: 'posix', caseFold: false })
  const exists = (path: string) => fs.entriesNow(path) !== null || fs.headNow(path, 1) !== null
  const paths: MinePathProbe = {
    realpath: (path) => {
      const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
      return exists(trimmed) ? trimmed : null
    },
    kindOf: (path) =>
      fs.entriesNow(path) !== null ? 'directory' : fs.headNow(path, 1) !== null ? 'file' : null
  }
  const remeasured: MineId[] = []
  const commands = createDeclareCommands({
    repository,
    transactions,
    resolver,
    paths,
    ids,
    clock,
    bus,
    hostEpoch: 'epoch-066',
    style: 'posix',
    remeasure: (mineId) => remeasured.push(mineId)
  })
  const mines = () => repository.snapshot().mines
  const save = (mine: Mine) => transactions.inTransaction(() => repository.save(mine))
  return { commands, repository, bus, remeasured, mines, save, ids }
}

async function declared(w: ReturnType<typeof world>, path: string): Promise<MineId> {
  const result = await w.commands.declare(at(path))
  expect(result, path).toEqual({ ok: true, value: { mineId: expect.any(String) } })
  return (result as { value: { mineId: MineId } }).value.mineId
}

describe('declare and adoptMainProject (16 §4.1, UC-039)', () => {
  it('[US-MINES-004.AC01, S3.04] declaring a plain folder creates a measuring mine with no ore and publishes MineCreated declared', async () => {
    const w = world()

    const result = await w.commands.declare(at('/work/plain'))

    expect(result.ok).toBe(true)
    const mineId = await declared(w, '/work/plain/') // a second spelling: the same mine (INV-02)
    expect(result).toEqual({ ok: true, value: { mineId } })
    expect(w.mines()).toHaveLength(1)
    expect(w.repository.byId(mineId)).toMatchObject({
      path: '/work/plain',
      name: 'plain',
      state: 'measuring',
      tier: null,
      sourceWeight: null,
      createdAt: T0
    })
    expect(w.repository.ledgerRows(mineId)).toBe(0)
    expect(w.bus.published).toEqual([
      {
        type: 'MineCreated',
        v: 1,
        id: expect.any(String),
        at: T0,
        hostEpoch: 'epoch-066',
        payload: { mineId, path: '/work/plain', name: 'plain', origin: 'declared' }
      }
    ])
    expect(w.remeasured).toEqual([mineId])
  })

  it('[US-MAP-004.AC01] the declared mine carries a map site so its marker appears at once', async () => {
    const w = world()

    const mineId = await declared(w, '/work/plain')

    expect(w.repository.byId(mineId)?.mapSite).toEqual(SITE)
  })

  it('[US-MINES-004.AC02, S3.07] a cancelled picker sends nothing and nothing changes', async () => {
    const w = world()

    // A cancelled picker never calls the handler, and the module keeps no state between calls.
    expect(w.mines()).toEqual([])
    expect(w.bus.published).toEqual([])

    // A path the Host refuses on re-validation creates nothing either (S3.07, ADR-019 item 9).
    expect(await w.commands.declare(at('plain'))).toEqual({ ok: false, error: 'invalid-path' })
    expect(await w.commands.declare(at('/work/pl\0ain'))).toEqual({
      ok: false,
      error: 'invalid-path'
    })
    expect(await w.commands.declare(at('/work/plain/readme.md'))).toEqual({
      ok: false,
      error: 'not-a-folder'
    })
    expect(await w.commands.declare(at('/work/nowhere'))).toEqual({
      ok: false,
      error: 'not-a-folder'
    })
    expect(w.mines()).toEqual([])
    expect(w.bus.published).toEqual([])
    expect(w.remeasured).toEqual([])
  })

  it('[US-MINES-004.AC03] declaring a linked worktree answers worktreeOf and writes nothing', async () => {
    const w = world()
    const repo = await declared(w, '/work/repo')
    const before = { mines: w.mines(), events: w.bus.published.length }

    expect(await w.commands.declare(at('/work/feat'))).toEqual({
      ok: true,
      value: { worktreeOf: repo }
    })
    expect(w.mines()).toEqual(before.mines)
    expect(w.bus.published).toHaveLength(before.events)
  })

  it('[US-MINES-004.AC03, S3.05] a linked worktree whose main tree has no mine answers a fresh id that names no stored mine, and adopting creates the main tree mine', async () => {
    const w = world()

    // UC-039 "worktreeOf mineId of T (or of a new main tree)": the id is minted, never stored.
    const asked = await w.commands.declare(at('/work/feat'))
    expect(asked).toEqual({ ok: true, value: { worktreeOf: expect.any(String) } })
    const fresh = (asked as { value: { worktreeOf: MineId } }).value.worktreeOf
    expect(w.repository.byId(fresh)).toBeNull()
    expect(w.mines()).toEqual([])
    expect(w.bus.published).toEqual([])

    const adopted = await w.commands.adoptMainProject(at('/work/feat'))
    expect(adopted.ok).toBe(true)
    const mineId = (adopted as { value: { mineId: MineId } }).value.mineId
    expect(w.repository.byId(mineId)).toMatchObject({ path: '/work/repo', state: 'measuring' })
    expect(w.bus.ofType('MineCreated').map((event) => event.payload)).toEqual([
      { mineId, path: '/work/repo', name: 'repo', origin: 'worktree-fold' }
    ])
    expect(w.remeasured).toEqual([mineId])

    // A folder that is no linked worktree has no main project to adopt.
    expect(await w.commands.adoptMainProject(at('/work/plain'))).toEqual({
      ok: false,
      error: 'no-main-project'
    })
    expect(await w.commands.adoptMainProject(at('feat'))).toEqual({
      ok: false,
      error: 'no-main-project'
    })
  })

  it('[US-MINES-004.AC06, S3.06] adopting the main project of an existing mine adds no mine and returns its id', async () => {
    const w = world()
    const repo = await declared(w, '/work/repo')
    const before = { mines: w.mines(), events: w.bus.published.length }

    expect(await w.commands.adoptMainProject(at('/work/feat'))).toEqual({
      ok: true,
      value: { mineId: repo }
    })
    expect(w.mines()).toEqual(before.mines)
    expect(w.bus.published).toHaveLength(before.events)
  })

  it('[US-OBS-001.AC04, INV-04] a declared mine starts measuring, not unrecorded', async () => {
    const w = world()

    const mineId = await declared(w, '/work/plain')

    expect(w.repository.byId(mineId)).toMatchObject({ state: 'measuring', hasBeenMeasured: false })
  })

  it("[S3.21, INV-07] declaring a removed mine's folder reattaches the same id", async () => {
    const w = world()
    const mineId = await declared(w, '/work/plain')
    const mine = w.repository.byId(mineId) as Mine
    const asked = transition(mine, { type: 'removal-requested' }, T0).mine as Mine
    w.save(transition(asked, { type: 'removal-settled', everyDwarfEnded: true }, T0).mine as Mine)
    w.repository.credit(mineId, 'gold', 7)

    expect(await w.commands.declare(at('/work/plain'))).toEqual({ ok: true, value: { mineId } })
    expect(w.mines()).toHaveLength(1)
    const back = w.repository.byId(mineId)
    expect(back).toMatchObject({ state: 'measuring', mapSite: SITE })
    expect(back?.removedAt).toBeUndefined()
    expect(w.repository.ledgerRows(mineId)).toBe(1)
    expect(w.bus.ofType('MineReattached').map((event) => event.payload)).toEqual([
      { mineId, via: 'manual-add' }
    ])
    expect(w.remeasured).toEqual([mineId, mineId])
  })
})
