import { describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { DirEntry, FileStat, FsLike } from '../adapters/fsLike'
import { defaultDwarf, defaultProviderSnapshot, type ProviderSnapshot } from '../domain/types'
import {
  createProjectRootResolver,
  foldWorktreeSnapshots,
  resolveProjectRoot,
  type ProjectRootResolution
} from './worktree'

/**
 * One repository with a main working tree and one linked worktree, exactly as
 * git lays it out on disk — the `.git` FILE in the worktree, the per-worktree
 * administrative directory under the main tree's `.git`, and the `commondir`
 * that points back.
 */
function repoWithWorktree(fs: FakeFs): void {
  fs.addFile('C:/Code/Anvil/.git/HEAD', 'ref: refs/heads/main\n')
  fs.addFile('C:/Code/Anvil/README.md', '#')
  fs.addFile('C:/Code/Anvil-worktrees/forge/.git', 'gitdir: C:/Code/Anvil/.git/worktrees/forge\n')
  fs.addFile('C:/Code/Anvil/.git/worktrees/forge/commondir', '../..\n')
  fs.addFile('C:/Code/Anvil/.git/worktrees/forge/HEAD', 'ref: refs/heads/feat/forge\n')
}

/** Counts what a resolution actually costs, so the cache can be held to a number. */
class CountingFs implements FsLike {
  reads = 0
  stats = 0
  constructor(private readonly inner: FsLike) {}
  async readTextTail(path: string, maxBytes: number): Promise<string> {
    this.reads++
    return this.inner.readTextTail(path, maxBytes)
  }
  async readTextHead(path: string, maxBytes: number): Promise<string> {
    this.reads++
    return this.inner.readTextHead(path, maxBytes)
  }
  async readJson(path: string): Promise<unknown> {
    this.reads++
    return this.inner.readJson(path)
  }
  async listDir(path: string): Promise<DirEntry[]> {
    return this.inner.listDir(path)
  }
  async stat(path: string): Promise<FileStat | null> {
    this.stats++
    return this.inner.stat(path)
  }
  async exists(path: string): Promise<boolean> {
    return this.inner.exists(path)
  }
}

describe('resolveProjectRoot', () => {
  it('leaves a main working tree alone', async () => {
    const fs = new FakeFs()
    repoWithWorktree(fs)
    expect(await resolveProjectRoot('C:/Code/Anvil', fs, 'win32')).toEqual({
      root: 'C:/Code/Anvil'
    })
  })

  it('folds a linked worktree onto the main working tree, with its branch', async () => {
    const fs = new FakeFs()
    repoWithWorktree(fs)
    expect(await resolveProjectRoot('C:/Code/Anvil-worktrees/forge', fs, 'win32')).toEqual({
      root: 'C:\\Code\\Anvil',
      worktree: { path: 'C:/Code/Anvil-worktrees/forge', branch: 'feat/forge' }
    })
  })

  it('folds a cwd that is a SUBFOLDER of a worktree, and keeps that cwd as the workplace', async () => {
    const fs = new FakeFs()
    repoWithWorktree(fs)
    fs.addFile('C:/Code/Anvil-worktrees/forge/src/main/index.ts', 'x')
    // The workplace is the session's own cwd, never the worktree's top folder:
    // a relative path in an activity line (#279) is relative to THAT.
    expect(await resolveProjectRoot('C:/Code/Anvil-worktrees/forge/src/main', fs, 'win32')).toEqual(
      {
        root: 'C:\\Code\\Anvil',
        worktree: { path: 'C:/Code/Anvil-worktrees/forge/src/main', branch: 'feat/forge' }
      }
    )
  })

  it('reports the short commit of a detached worktree and no branch', async () => {
    const fs = new FakeFs()
    repoWithWorktree(fs)
    fs.addFile(
      'C:/Code/Anvil/.git/worktrees/forge/HEAD',
      '3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a\n'
    )
    expect(await resolveProjectRoot('C:/Code/Anvil-worktrees/forge', fs, 'win32')).toEqual({
      root: 'C:\\Code\\Anvil',
      worktree: { path: 'C:/Code/Anvil-worktrees/forge', commit: '3f2a1b9' }
    })
  })

  it('never folds a submodule, whose .git file points at a modules/ directory with no commondir', async () => {
    const fs = new FakeFs()
    repoWithWorktree(fs)
    fs.addFile('C:/Code/Anvil/vendor/lib/.git', 'gitdir: ../../.git/modules/lib\n')
    fs.addFile('C:/Code/Anvil/.git/modules/lib/HEAD', 'ref: refs/heads/main\n')
    expect(await resolveProjectRoot('C:/Code/Anvil/vendor/lib', fs, 'win32')).toEqual({
      root: 'C:/Code/Anvil/vendor/lib'
    })
  })

  it('never folds a worktree of a BARE repository, which has no main working tree', async () => {
    const fs = new FakeFs()
    fs.addFile('C:/Code/anvil.git/HEAD', 'ref: refs/heads/main\n')
    fs.addFile('C:/Code/anvil.git/worktrees/forge/commondir', '../..\n')
    fs.addFile('C:/Code/anvil.git/worktrees/forge/HEAD', 'ref: refs/heads/feat/forge\n')
    fs.addFile('C:/Code/forge/.git', 'gitdir: C:/Code/anvil.git/worktrees/forge\n')
    expect(await resolveProjectRoot('C:/Code/forge', fs, 'win32')).toEqual({
      root: 'C:/Code/forge'
    })
  })

  it('never folds when the .git file points outside the filesystem it describes', async () => {
    const fs = new FakeFs()
    repoWithWorktree(fs)
    fs.addFile('C:/Code/orphan/.git', 'gitdir: D:/gone/.git/worktrees/orphan\n')
    expect(await resolveProjectRoot('C:/Code/orphan', fs, 'win32')).toEqual({
      root: 'C:/Code/orphan'
    })
  })

  it('never folds a .git file with no gitdir line at all', async () => {
    const fs = new FakeFs()
    fs.addFile('C:/Code/odd/.git', 'this is not a git pointer\n')
    expect(await resolveProjectRoot('C:/Code/odd', fs, 'win32')).toEqual({ root: 'C:/Code/odd' })
  })

  it('leaves a folder that is in no repository at all alone', async () => {
    const fs = new FakeFs()
    fs.addFile('C:/Code/Notes/todo.md', '-')
    expect(await resolveProjectRoot('C:/Code/Notes', fs, 'win32')).toEqual({
      root: 'C:/Code/Notes'
    })
  })

  it('folds on POSIX too, where the separator and the case rules both differ', async () => {
    const fs = new FakeFs()
    fs.addFile('/home/j/anvil/.git/HEAD', 'ref: refs/heads/main\n')
    fs.addFile('/home/j/anvil-worktrees/forge/.git', 'gitdir: /home/j/anvil/.git/worktrees/forge\n')
    fs.addFile('/home/j/anvil/.git/worktrees/forge/commondir', '../..\n')
    fs.addFile('/home/j/anvil/.git/worktrees/forge/HEAD', 'ref: refs/heads/feat/forge\n')
    expect(await resolveProjectRoot('/home/j/anvil-worktrees/forge', fs, 'linux')).toEqual({
      root: '/home/j/anvil',
      worktree: { path: '/home/j/anvil-worktrees/forge', branch: 'feat/forge' }
    })
  })

  it('resolves a RELATIVE gitdir pointer against the worktree folder', async () => {
    const fs = new FakeFs()
    fs.addFile('/home/j/anvil/.git/HEAD', 'ref: refs/heads/main\n')
    fs.addFile('/home/j/anvil/wt/forge/.git', 'gitdir: ../../.git/worktrees/forge\n')
    fs.addFile('/home/j/anvil/.git/worktrees/forge/commondir', '../..\n')
    fs.addFile('/home/j/anvil/.git/worktrees/forge/HEAD', 'ref: refs/heads/feat/forge\n')
    expect(await resolveProjectRoot('/home/j/anvil/wt/forge', fs, 'linux')).toEqual({
      root: '/home/j/anvil',
      worktree: { path: '/home/j/anvil/wt/forge', branch: 'feat/forge' }
    })
  })
})

describe('createProjectRootResolver', () => {
  it('answers a repeated cwd from the cache without touching the disk again', async () => {
    const fake = new FakeFs()
    repoWithWorktree(fake)
    const fs = new CountingFs(fake)
    const clock = { now: 1_000 }
    const resolver = createProjectRootResolver({ fs, platform: 'win32', now: () => clock.now })

    const first = await resolver.resolve('C:/Code/Anvil-worktrees/forge')
    const cost = { reads: fs.reads, stats: fs.stats }
    expect(cost.reads).toBeGreaterThan(0)

    const second = await resolver.resolve('C:/Code/Anvil-worktrees/forge')
    expect(second).toEqual(first)
    expect(fs.reads).toBe(cost.reads)
    expect(fs.stats).toBe(cost.stats)
  })

  it('re-reads once the entry is older than its window, so a branch switch shows', async () => {
    const fake = new FakeFs()
    repoWithWorktree(fake)
    const fs = new CountingFs(fake)
    const clock = { now: 1_000 }
    const resolver = createProjectRootResolver({
      fs,
      platform: 'win32',
      now: () => clock.now,
      ttlMs: 30_000
    })

    await resolver.resolve('C:/Code/Anvil-worktrees/forge')
    clock.now += 30_001
    fake.addFile('C:/Code/Anvil/.git/worktrees/forge/HEAD', 'ref: refs/heads/feat/anvil-bell\n')
    const again = await resolver.resolve('C:/Code/Anvil-worktrees/forge')
    expect(again.worktree?.branch).toBe('feat/anvil-bell')
  })

  it('shares one cache entry between two cwds that differ only in case on Windows', async () => {
    const fake = new FakeFs()
    repoWithWorktree(fake)
    const fs = new CountingFs(fake)
    const resolver = createProjectRootResolver({ fs, platform: 'win32', now: () => 0 })

    await resolver.resolve('C:/Code/Anvil-worktrees/forge')
    const cost = fs.reads
    await resolver.resolve('c:/code/anvil-worktrees/forge')
    expect(fs.reads).toBe(cost)
  })
})

function snapshot(overrides: Partial<ProviderSnapshot>): ProviderSnapshot {
  return { ...defaultProviderSnapshot(), ...overrides }
}

const FOLDED: ProjectRootResolution = {
  root: 'C:\\Code\\Anvil',
  worktree: { path: 'C:\\Code\\Anvil-worktrees\\forge', branch: 'feat/forge' }
}

describe('foldWorktreeSnapshots', () => {
  it('gives a worktree session the main tree as its cwd and keeps the worktree on its dwarfs', () => {
    const folded = foldWorktreeSnapshots(
      [
        snapshot({
          cwd: 'C:\\Code\\Anvil-worktrees\\forge',
          dwarfs: [{ ...defaultDwarf(), id: 'd1' }]
        })
      ],
      () => FOLDED
    )
    expect(folded[0]!.cwd).toBe('C:\\Code\\Anvil')
    expect(folded[0]!.dwarfs[0]!.workplace).toEqual({
      path: 'C:\\Code\\Anvil-worktrees\\forge',
      branch: 'feat/forge'
    })
  })

  it('drops the detached commit, which the wire does not carry for a dwarf', () => {
    const folded = foldWorktreeSnapshots(
      [snapshot({ cwd: 'C:\\Code\\wt', dwarfs: [{ ...defaultDwarf(), id: 'd1' }] })],
      () => ({ root: 'C:\\Code\\Anvil', worktree: { path: 'C:\\Code\\wt', commit: '3f2a1b9' } })
    )
    expect(folded[0]!.dwarfs[0]!.workplace).toEqual({ path: 'C:\\Code\\wt' })
  })

  it('leaves a snapshot whose cwd is its own project exactly as it was', () => {
    const snapshots = [
      snapshot({ cwd: 'C:\\Code\\Anvil', dwarfs: [{ ...defaultDwarf(), id: 'd1' }] })
    ]
    const folded = foldWorktreeSnapshots(snapshots, () => ({ root: 'C:\\Code\\Anvil' }))
    expect(folded).toBe(snapshots)
    expect(folded[0]!.dwarfs[0]!.workplace).toBeUndefined()
  })

  it('leaves a snapshot alone when nothing resolved its cwd at all', () => {
    const snapshots = [snapshot({ cwd: 'C:\\Code\\Anvil' })]
    expect(foldWorktreeSnapshots(snapshots, () => undefined)).toBe(snapshots)
  })

  it('folds two worktrees of one repository onto one cwd, so the aggregate makes one mine', () => {
    const folded = foldWorktreeSnapshots(
      [
        snapshot({ cwd: 'C:\\Code\\wt-a', dwarfs: [{ ...defaultDwarf(), id: 'a' }] }),
        snapshot({ cwd: 'C:\\Code\\wt-b', dwarfs: [{ ...defaultDwarf(), id: 'b' }] })
      ],
      (cwd) => ({
        root: 'C:\\Code\\Anvil',
        worktree: { path: cwd, branch: cwd.endsWith('a') ? 'feat/a' : 'feat/b' }
      })
    )
    expect(folded.map((item) => item.cwd)).toEqual(['C:\\Code\\Anvil', 'C:\\Code\\Anvil'])
    expect(folded.map((item) => item.dwarfs[0]!.workplace?.branch)).toEqual(['feat/a', 'feat/b'])
  })
})
