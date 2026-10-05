import { describe, expect, it } from 'vitest'
import { resolveProjectRoot, type WorktreeFacts } from './worktreeFold'

// The facts the inspector reads off disk (ISSUE-064), written by hand per ADR-030's fixture trees.
// POSIX paths unless the case says Windows. Synthetic folders only (privacy-guard).

const posix = { style: 'posix', caseFold: false } as const
const windows = { style: 'win32', caseFold: true } as const

/** A session in a main working tree, or any folder inside one: the nearest `.git` is a directory. */
const inCheckout = (cwd: string, folder: string): WorktreeFacts => ({
  ...posix,
  cwd,
  dotGit: { kind: 'directory', folder }
})

/** A session in a linked worktree of `/src/repo`, on branch `feat/ore`. */
const linkedWorktree = (cwd: string): WorktreeFacts => ({
  ...posix,
  cwd,
  dotGit: {
    kind: 'file',
    folder: '/src/repo-wt',
    text: 'gitdir: /src/repo/.git/worktrees/repo-wt\n',
    commondirText: '../..\n',
    headText: 'ref: refs/heads/feat/ore\n',
    mainTree: { realPath: '/src/repo', hasGitDirectory: true }
  }
})

describe('resolveProjectRoot: the worktree fold (ADR-030 item 2, INV-03)', () => {
  it('[US-OBS-003.AC01, US-MINES-004.AC05, INV-03] an ordinary subfolder of a mine is its own mine key', () => {
    expect(resolveProjectRoot(inCheckout('/src/repo/packages/app', '/src/repo'))).toEqual({
      mineKey: '/src/repo/packages/app'
    })
    expect(resolveProjectRoot(inCheckout('/src/repo', '/src/repo'))).toEqual({
      mineKey: '/src/repo'
    })
  })

  it('[US-OBS-003.AC02, INV-03] a linked worktree folds onto its main working tree and keeps its cwd as the workplace', () => {
    expect(resolveProjectRoot(linkedWorktree('/src/repo-wt'))).toEqual({
      mineKey: '/src/repo',
      workplace: { path: '/src/repo-wt', branch: 'feat/ore' }
    })
    // A subfolder of a linked worktree folds too, and keeps its own cwd (ADR-030 item 2).
    expect(resolveProjectRoot(linkedWorktree('/src/repo-wt/lib'))).toEqual({
      mineKey: '/src/repo',
      workplace: { path: '/src/repo-wt/lib', branch: 'feat/ore' }
    })
    // A detached worktree still folds; its workplace has no branch (the chip names the folder).
    const detached = linkedWorktree('/src/repo-wt')
    expect(
      resolveProjectRoot({
        ...detached,
        dotGit: { ...detached.dotGit, headText: '0123456789abcdef0123456789abcdef01234567\n' }
      } as WorktreeFacts)
    ).toEqual({ mineKey: '/src/repo', workplace: { path: '/src/repo-wt' } })
    // A relative gitdir pointer resolves against the folder holding the `.git` file.
    expect(
      resolveProjectRoot({
        ...posix,
        cwd: '/src/repo-wt',
        dotGit: {
          kind: 'file',
          folder: '/src/repo-wt',
          text: 'gitdir: ../repo/.git/worktrees/repo-wt',
          commondirText: '../..',
          headText: 'ref: refs/heads/main',
          mainTree: { realPath: '/src/repo', hasGitDirectory: true }
        }
      })
    ).toEqual({ mineKey: '/src/repo', workplace: { path: '/src/repo-wt', branch: 'main' } })
  })

  it('[US-OBS-003.AC03] a submodule and a worktree of a bare repository are their own mines', () => {
    // A submodule's `.git` file points under `.git/modules/`, where git writes no `commondir`.
    // The superproject is a real main tree right above it, and still nothing folds.
    const submodule: WorktreeFacts = {
      ...posix,
      cwd: '/src/repo/vendor/lib',
      dotGit: {
        kind: 'file',
        folder: '/src/repo/vendor/lib',
        text: 'gitdir: ../../.git/modules/vendor/lib',
        commondirText: null,
        headText: 'ref: refs/heads/main',
        mainTree: { realPath: '/src/repo', hasGitDirectory: true }
      }
    }
    expect(resolveProjectRoot(submodule)).toEqual({ mineKey: '/src/repo/vendor/lib' })

    // A worktree of a bare repository: its common dir is the bare repo, not a `.git` folder.
    const bare: WorktreeFacts = {
      ...posix,
      cwd: '/srv/wt',
      dotGit: {
        kind: 'file',
        folder: '/srv/wt',
        text: 'gitdir: /srv/repo.git/worktrees/wt',
        commondirText: '../..',
        headText: 'ref: refs/heads/main',
        mainTree: { realPath: '/srv', hasGitDirectory: true }
      }
    }
    expect(resolveProjectRoot(bare)).toEqual({ mineKey: '/srv/wt' })

    // The legacy guard stays: the main tree must own a `.git` DIRECTORY.
    const noGitDirectory = linkedWorktree('/src/repo-wt')
    expect(
      resolveProjectRoot({
        ...noGitDirectory,
        dotGit: {
          ...noGitDirectory.dotGit,
          mainTree: { realPath: '/src/repo', hasGitDirectory: false }
        }
      } as WorktreeFacts)
    ).toEqual({ mineKey: '/src/repo-wt' })
  })

  it('[US-OBS-003.AC04] two unrelated folders nested at any depth are two mines', () => {
    const outer = resolveProjectRoot({ ...posix, cwd: '/data/a', dotGit: { kind: 'none' } })
    const nestedRepo = resolveProjectRoot(inCheckout('/data/a/b', '/data/a/b'))
    const inner = resolveProjectRoot(inCheckout('/data/a/b/c/d', '/data/a/b'))
    expect(new Set([outer.mineKey, nestedRepo.mineKey, inner.mineKey]).size).toBe(3)
    expect(inner).toEqual({ mineKey: '/data/a/b/c/d' })
  })

  it('[ADR-030] backslash and forward-slash spellings of one worktree fold the same way', () => {
    const facts = (text: string): WorktreeFacts => ({
      ...windows,
      cwd: 'C:\\src\\repo-wt',
      dotGit: {
        kind: 'file',
        folder: 'C:\\src\\repo-wt',
        text,
        commondirText: '../..',
        headText: 'ref: refs/heads/main',
        mainTree: { realPath: 'C:\\src\\Repo', hasGitDirectory: true }
      }
    })
    const expected = {
      mineKey: 'c:\\src\\repo',
      workplace: { path: 'C:\\src\\repo-wt', branch: 'main' }
    }
    expect(resolveProjectRoot(facts('gitdir: C:/src/Repo/.git/worktrees/repo-wt'))).toEqual(
      expected
    )
    expect(resolveProjectRoot(facts('gitdir: C:\\src\\Repo\\.git\\worktrees\\repo-wt'))).toEqual(
      expected
    )
  })

  it('[ADR-030] anything unreadable or unrecognised answers the folder itself', () => {
    const base = linkedWorktree('/src/repo-wt')
    const variants: WorktreeFacts['dotGit'][] = [
      { ...base.dotGit, text: null } as WorktreeFacts['dotGit'],
      { ...base.dotGit, text: 'not a pointer' } as WorktreeFacts['dotGit'],
      { ...base.dotGit, commondirText: null } as WorktreeFacts['dotGit'],
      { ...base.dotGit, mainTree: null } as WorktreeFacts['dotGit']
    ]
    for (const dotGit of variants) {
      expect(resolveProjectRoot({ ...base, dotGit })).toEqual({ mineKey: '/src/repo-wt' })
    }
    // Nothing folds onto itself.
    expect(
      resolveProjectRoot({
        ...base,
        dotGit: { ...base.dotGit, mainTree: { realPath: '/src/repo-wt', hasGitDirectory: true } }
      } as WorktreeFacts)
    ).toEqual({ mineKey: '/src/repo-wt' })
  })
})
