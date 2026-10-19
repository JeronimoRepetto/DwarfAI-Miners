// The ADR-030 Verification fixture trees (16 §4.1 row `MineIdentityResolver`, ISSUE-064): a main
// working tree with linked worktrees (one on a branch, one detached, one whose `gitdir:` pointer is
// written with backslashes), a superproject with a submodule, a bare repository with a worktree, a
// folder with an unrecognised `.git` file and a plain folder. Written as data, not as folders,
// because git refuses to track any path with a `.git` segment: the contract plants them in a
// FakeFs or in a temporary directory with plain file writes, never with `git`.
//
// Paths are relative to the planted root and use `/`. Absolute pointers name that root the way
// git writes them on each OS (forward slashes, also on Windows), except the backslash case.
import type { PathStyle } from '../../../domain/minePath'

/** One fixture entry: a file with its text, or an empty folder when `text` is absent. */
export interface FixtureEntry {
  readonly path: string
  readonly text?: string
}

/** A detached HEAD's commit (40 hex digits; the chip shows its first seven). */
export const DETACHED_SHA = '0123456789abcdef0123456789abcdef01234567'

/** The branch the linked worktree `repo-wt` has checked out. */
export const WORKTREE_BRANCH = 'feat/ore-ledger'

/** Every fixture tree under one root folder, whose real path is `root` in `style`. */
export function gitFixtureTrees(root: string, style: PathStyle): FixtureEntry[] {
  // git writes absolute pointers with forward slashes on every OS.
  const forward = style === 'win32' ? root.replace(/\\/g, '/') : root
  const backward = root.replace(/\//g, '\\')
  return [
    // A main working tree.
    { path: 'repo/.git/HEAD', text: 'ref: refs/heads/main\n' },
    { path: 'repo/.git/config', text: '[core]\n\tbare = false\n' },
    { path: 'repo/src/main.ts', text: '// a source file\n' },
    // A linked worktree on a branch, with a subfolder a session can start in.
    { path: 'repo/.git/worktrees/wt/commondir', text: '../..\n' },
    { path: 'repo/.git/worktrees/wt/HEAD', text: `ref: refs/heads/${WORKTREE_BRANCH}\n` },
    { path: 'repo/.git/worktrees/wt/gitdir', text: `${forward}/repo-wt/.git\n` },
    { path: 'repo-wt/.git', text: `gitdir: ${forward}/repo/.git/worktrees/wt\n` },
    { path: 'repo-wt/src/lib.ts', text: '// a source file\n' },
    // A linked worktree with a detached HEAD.
    { path: 'repo/.git/worktrees/detached/commondir', text: '../..\n' },
    { path: 'repo/.git/worktrees/detached/HEAD', text: `${DETACHED_SHA}\n` },
    { path: 'repo-detached/.git', text: `gitdir: ${forward}/repo/.git/worktrees/detached\n` },
    // A linked worktree whose pointer is written with backslashes (HR W1); Windows only.
    ...(style === 'win32'
      ? [
          { path: 'repo/.git/worktrees/bs/commondir', text: '..\\..\r\n' },
          { path: 'repo/.git/worktrees/bs/HEAD', text: `ref: refs/heads/${WORKTREE_BRANCH}\r\n` },
          { path: 'repo-bs/.git', text: `gitdir: ${backward}\\repo\\.git\\worktrees\\bs\r\n` }
        ]
      : []),
    // A superproject and its submodule: the submodule's admin folder has no `commondir`.
    { path: 'super/.git/HEAD', text: 'ref: refs/heads/main\n' },
    { path: 'super/.git/modules/lib/HEAD', text: 'ref: refs/heads/main\n' },
    { path: 'super/lib/.git', text: 'gitdir: ../.git/modules/lib\n' },
    // A bare repository and a worktree of it: no main working tree to fold onto.
    { path: 'bare.git/HEAD', text: 'ref: refs/heads/main\n' },
    { path: 'bare.git/worktrees/bwt/commondir', text: '../..\n' },
    { path: 'bare.git/worktrees/bwt/HEAD', text: 'ref: refs/heads/main\n' },
    { path: 'bare-wt/.git', text: `gitdir: ${forward}/bare.git/worktrees/bwt\n` },
    // A `.git` file that is not a pointer.
    { path: 'odd/.git', text: 'not a pointer\n' },
    // A plain folder, inside no repository.
    { path: 'plain' }
  ]
}
