import { describe, expect, it } from 'vitest'
import {
  dwarfWorkplaceLabel,
  worktreeFolderName,
  worktreeMineName,
  worktreeQuestionAccept,
  worktreeQuestionBody,
  worktreeQuestionTitle
} from './worktree'

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

/*
 * The sentence these replaced named the branch or the commit ("…, on branch feat/forge. Its
 * sessions already show up in that project's mine."). US-MINES-004.AC07 (PO decision 2026-09-28
 * #41) fixes the dialog's copy and names neither, so the three cases below now prove that the
 * copy is the same whatever the worktree's HEAD says.
 */
describe('worktreeQuestionBody', () => {
  it('says where the dwarfs of a worktree on a branch will work', () => {
    expect(
      worktreeQuestionBody({
        worktree: 'C:\\Code\\Anvil-worktrees\\forge',
        root: 'C:\\Code\\Anvil',
        branch: 'feat/forge'
      })
    ).toBe('Its dwarfs will work in Anvil.')
  })

  it('says the same of a detached worktree, naming no commit', () => {
    expect(
      worktreeQuestionBody({
        worktree: '/home/j/anvil-worktrees/forge',
        root: '/home/j/anvil',
        commit: '3f2a1b9'
      })
    ).toBe('Its dwarfs will work in anvil.')
  })

  it('says the same when the worktree s HEAD said neither', () => {
    expect(worktreeQuestionBody({ worktree: 'C:\\Code\\wt', root: 'C:\\Code\\Anvil' })).toBe(
      'Its dwarfs will work in Anvil.'
    )
  })

  it('[US-MINES-004.AC07] titles the dialog with the folder and its mine, and offers to add that mine', () => {
    // A trailing separator on the main tree's path still names its folder.
    const question = {
      worktree: 'C:\\Code\\Anvil-worktrees\\forge',
      root: 'C:\\Code\\Anvil\\',
      branch: 'x'
    }
    expect(worktreeMineName(question)).toBe('Anvil')
    expect(worktreeQuestionTitle(question)).toBe('forge is a worktree of Anvil')
    expect(worktreeQuestionBody(question)).toBe('Its dwarfs will work in Anvil.')
    expect(worktreeQuestionAccept(question)).toBe('Add Anvil')
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

/*
 * C-08 (18 §5.1, NFR-SEC-07): the worktree dialog names two folders, and a repository chose both.
 * Each name is drawn without its escape sequences, control characters and bidi controls, as the
 * mine card draws the same names (#1341).
 */
describe('the worktree dialog, untrusted folder names (C-08)', () => {
  it('[NFR-SEC-07] strips a hostile folder and mine name in the title, the body and the action', () => {
    const question = {
      worktree: 'C:\\dev\\\u001b[31mfix\u202Eexe\u0000',
      root: 'C:\\dev\\an\u2066vil\u001b]0;title\u0007'
    }
    expect(worktreeMineName(question)).toBe('anvil')
    expect(worktreeQuestionTitle(question)).toBe('fixexe is a worktree of anvil')
    expect(worktreeQuestionBody(question)).toBe('Its dwarfs will work in anvil.')
    expect(worktreeQuestionAccept(question)).toBe('Add anvil')
  })
})
