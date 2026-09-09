import { describe, expect, it } from 'vitest'
import { dwarfWorkplaceLabel, worktreeFolderName, worktreeQuestionBody } from './worktree'

describe('worktreeFolderName', () => {
  it.each([
    ['C:\\Code\\Anvil-worktrees\\forge', 'forge'],
    ['/home/j/anvil-worktrees/forge', 'forge'],
    ['C:\\Code\\Anvil-worktrees\\forge\\', 'forge'],
    ['C:\\Code\\Anvil-worktrees/forge', 'forge']
  ])('names the folder in %s', (path, expected) => {
    expect(worktreeFolderName(path)).toBe(expected)
  })

  it('answers with the whole path when there is no segment to take', () => {
    // A filesystem root is a real place a session can run; a blank label where
    // a folder belongs would say nothing at all.
    expect(worktreeFolderName('/')).toBe('/')
  })
})

describe('worktreeQuestionBody', () => {
  it('names the folder, the project and the branch', () => {
    expect(
      worktreeQuestionBody({
        worktree: 'C:\\Code\\Anvil-worktrees\\forge',
        root: 'C:\\Code\\Anvil',
        branch: 'feat/forge'
      })
    ).toBe(
      'forge is a worktree of C:\\Code\\Anvil, on branch feat/forge. ' +
        "Its sessions already show up in that project's mine."
    )
  })

  it('names the commit of a detached worktree, which has no branch to name', () => {
    expect(
      worktreeQuestionBody({
        worktree: '/home/j/anvil-worktrees/forge',
        root: '/home/j/anvil',
        commit: '3f2a1b9'
      })
    ).toBe(
      'forge is a worktree of /home/j/anvil, at commit 3f2a1b9. ' +
        "Its sessions already show up in that project's mine."
    )
  })

  it('says only what it knows when the worktree s HEAD said neither', () => {
    expect(worktreeQuestionBody({ worktree: 'C:\\Code\\wt', root: 'C:\\Code\\Anvil' })).toBe(
      "wt is a worktree of C:\\Code\\Anvil. Its sessions already show up in that project's mine."
    )
  })
})

describe('dwarfWorkplaceLabel', () => {
  it('names the branch a worktree has checked out', () => {
    expect(dwarfWorkplaceLabel({ path: 'C:\\Code\\wt', branch: 'feat/console-paste' })).toBe(
      'feat/console-paste'
    )
  })

  it('names the folder of a detached worktree, which has no branch', () => {
    // The wire deliberately carries no commit for a dwarf: a short sha is not
    // a name anybody navigates by, and the folder is.
    expect(dwarfWorkplaceLabel({ path: 'C:\\Code\\Anvil-worktrees\\forge' })).toBe('forge')
  })

  it('says nothing at all for a dwarf working in the mine s own folder', () => {
    expect(dwarfWorkplaceLabel(undefined)).toBe('')
  })
})
