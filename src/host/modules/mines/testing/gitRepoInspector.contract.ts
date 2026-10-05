// The GitRepoInspector conformance suite (16 §4.1 rows `MineIdentityResolver` / `GitHeadWatchPort`,
// 16 §2.8, 17 §1.3): run against FakeGitRepoInspector over FakeFs and against FsGitRepoInspector
// over a temporary copy of the ADR-030 fixture trees (`adapters/__fixtures__/git/trees.ts`). Each
// case holds for both, so a consumer tested with the double sees what the disk would give it.
import { describe, expect, it } from 'vitest'
import { DETACHED_SHA, WORKTREE_BRANCH } from '../adapters/__fixtures__/git/trees'
import { canonicalMinePath, separatorOf, type PathStyle } from '../domain/minePath'
import type { GitHeadWatchPort } from '../ports/gitHeadWatchPort'
import type { MineIdentityResolver } from '../ports/mineIdentityResolver'

/** The resolver cache's lifetime (ADR-030 item 4; 16 §4.1 "30 s resolver cache"). */
const RESOLVER_TTL_MS = 30_000

/**
 * One inspector over the fixture trees, planted under `root`. The storage operations act on the
 * subject's storage directly, never through the inspector under test; paths are relative to
 * `root` and written with `/`.
 */
export interface GitRepoInspectorSubject {
  readonly inspector: MineIdentityResolver & GitHeadWatchPort
  /** The path rules of the subject's storage: the suite's `style`. */
  readonly style: PathStyle
  /** Whether the subject folds case on its volume (`caseFoldFor`). */
  readonly caseFold: boolean
  /** The real path of the folder the fixture trees are planted in. */
  readonly root: string
  /** Writes a file (parents included) and sets its mtime, in whole seconds. */
  write(relative: string, text: string, mtimeMs: number): Promise<void>
  /** Makes an existing file impossible to read as a file. */
  makeUnreadable(relative: string): Promise<void>
  /** Deletes a file. */
  remove(relative: string): Promise<void>
  /** Creates a second spelling of a folder: a link (a junction on Windows) at `link` to `target`. */
  link(link: string, target: string): Promise<void>
  /** Moves the inspector's clock forward. */
  advance(ms: number): void
}

export function runGitRepoInspectorContract(
  name: string,
  style: PathStyle,
  makeSubject: () => Promise<GitRepoInspectorSubject>
): void {
  describe(`GitRepoInspector contract: ${name} (${style} path rules)`, () => {
    it('[ADR-030] a cwd in a linked worktree resolves to the main working tree with the cwd as workplace', async () => {
      const subject = await makeSubject()
      const { inspector } = subject
      const at = pathIn(subject)

      await expect(inspector.resolve(at('repo-wt'))).resolves.toEqual({
        mineKey: keyIn(subject, 'repo'),
        workplace: { path: at('repo-wt'), branch: WORKTREE_BRANCH }
      })
      // A session started in a subfolder of the worktree folds too and keeps its own cwd.
      await expect(inspector.resolve(at('repo-wt', 'src'))).resolves.toEqual({
        mineKey: keyIn(subject, 'repo'),
        workplace: { path: at('repo-wt', 'src'), branch: WORKTREE_BRANCH }
      })
      // A detached worktree folds with no branch: the chip names the folder instead (ADR-030 item 4).
      await expect(inspector.resolve(at('repo-detached'))).resolves.toEqual({
        mineKey: keyIn(subject, 'repo'),
        workplace: { path: at('repo-detached') }
      })
      // The main working tree and a folder inside it are their own mines: nothing walks up.
      await expect(inspector.resolve(at('repo'))).resolves.toEqual({
        mineKey: keyIn(subject, 'repo')
      })
      await expect(inspector.resolve(at('repo', 'src'))).resolves.toEqual({
        mineKey: keyIn(subject, 'repo', 'src')
      })
    })

    it('[ADR-030] a submodule and a bare-repository worktree resolve to themselves', async () => {
      const subject = await makeSubject()
      const { inspector } = subject
      const at = pathIn(subject)

      await expect(inspector.resolve(at('super', 'lib'))).resolves.toEqual({
        mineKey: keyIn(subject, 'super', 'lib')
      })
      await expect(inspector.resolve(at('bare-wt'))).resolves.toEqual({
        mineKey: keyIn(subject, 'bare-wt')
      })
    })

    // A backslash is a filename character on POSIX, so the case exists only in Windows path rules;
    // the double runs this suite in Windows rules on every host.
    if (style === 'win32') {
      it('[ADR-030] a gitdir pointer written with backslashes resolves like one with forward slashes', async () => {
        const subject = await makeSubject()
        const { inspector } = subject
        const at = pathIn(subject)

        await expect(inspector.resolve(at('repo-bs'))).resolves.toEqual({
          mineKey: keyIn(subject, 'repo'),
          workplace: { path: at('repo-bs'), branch: WORKTREE_BRANCH }
        })
        await expect(inspector.head(at('repo-bs'))).resolves.toEqual({
          kind: 'branch',
          name: WORKTREE_BRANCH
        })
      })
    }

    it('[ADR-030] head answers branch, detached with a short sha, or none outside a repository', async () => {
      const subject = await makeSubject()
      const { inspector } = subject
      const at = pathIn(subject)

      await expect(inspector.head(at('repo'))).resolves.toEqual({ kind: 'branch', name: 'main' })
      await expect(inspector.head(at('repo', 'src'))).resolves.toEqual({
        kind: 'branch',
        name: 'main'
      })
      await expect(inspector.head(at('repo-wt', 'src'))).resolves.toEqual({
        kind: 'branch',
        name: WORKTREE_BRANCH
      })
      await expect(inspector.head(at('repo-detached'))).resolves.toEqual({
        kind: 'detached',
        shortSha: DETACHED_SHA.slice(0, 7)
      })
      await expect(inspector.head(at('plain'))).resolves.toEqual({ kind: 'none' })
    })

    it('[ADR-030] an unreadable .git answers own project and never throws', async () => {
      const subject = await makeSubject()
      const { inspector } = subject
      const at = pathIn(subject)

      // A `.git` file that is not a pointer, and a folder that does not exist.
      await expect(inspector.resolve(at('odd'))).resolves.toEqual({
        mineKey: keyIn(subject, 'odd')
      })
      await expect(inspector.head(at('odd'))).resolves.toEqual({ kind: 'none' })
      await expect(inspector.resolve(at('missing'))).resolves.toEqual({
        mineKey: keyIn(subject, 'missing')
      })
      await expect(inspector.head(at('missing'))).resolves.toEqual({ kind: 'none' })

      // A worktree whose `commondir` cannot be read proves no fold.
      await subject.makeUnreadable('repo/.git/worktrees/detached/commondir')
      await expect(inspector.resolve(at('repo-detached'))).resolves.toEqual({
        mineKey: keyIn(subject, 'repo-detached')
      })

      // A worktree whose `.git` file cannot be read: no fold, and no head.
      await subject.makeUnreadable('repo-wt/.git')
      await expect(inspector.resolve(at('repo-wt'))).resolves.toEqual({
        mineKey: keyIn(subject, 'repo-wt')
      })
      await expect(inspector.head(at('repo-wt'))).resolves.toEqual({ kind: 'none' })
    })

    it('[ADR-030] a cwd that is not absolute is never read against the Host own folder', async () => {
      const { inspector } = await makeSubject()

      // It names no folder: a programming error for the resolver (16 §2.1), no repository for head.
      await expect(inspector.resolve('repo-wt')).rejects.toThrow(/needs an absolute cwd/)
      await expect(inspector.head('repo-wt')).resolves.toEqual({ kind: 'none' })
    })

    it('[ADR-030] a second resolve within 30 s is served from the cache and a HEAD change is seen by mtime', async () => {
      const subject = await makeSubject()
      const { inspector } = subject
      const at = pathIn(subject)
      const folded = {
        mineKey: keyIn(subject, 'repo'),
        workplace: { path: at('repo-wt'), branch: WORKTREE_BRANCH }
      }
      await expect(inspector.resolve(at('repo-wt'))).resolves.toEqual(folded)

      // The worktree goes away: the cached answer stands for 30 s, then the disk is asked again.
      await subject.remove('repo-wt/.git')
      subject.advance(RESOLVER_TTL_MS - 1)
      await expect(inspector.resolve(at('repo-wt'))).resolves.toEqual(folded)
      subject.advance(1)
      await expect(inspector.resolve(at('repo-wt'))).resolves.toEqual({
        mineKey: keyIn(subject, 'repo-wt')
      })

      // A branch switch in the main tree shows on the next head, with no wait (ADR-030 item 4).
      const head = 'repo/.git/HEAD'
      await subject.write(head, 'ref: refs/heads/main\n', 1_700_000_000_000)
      await expect(inspector.head(at('repo'))).resolves.toEqual({ kind: 'branch', name: 'main' })
      await subject.write(head, 'ref: refs/heads/fix/vein\n', 1_700_000_005_000)
      await expect(inspector.head(at('repo'))).resolves.toEqual({
        kind: 'branch',
        name: 'fix/vein'
      })
      // The mtime is the trigger: a rewrite that keeps it is not read again.
      await subject.write(head, 'ref: refs/heads/other\n', 1_700_000_005_000)
      await expect(inspector.head(at('repo'))).resolves.toEqual({
        kind: 'branch',
        name: 'fix/vein'
      })
    })

    it('[ADR-030] two spellings of one folder through a link resolve to one mine key', async () => {
      const subject = await makeSubject()
      const { inspector } = subject
      const at = pathIn(subject)
      await subject.link('repo-link', 'repo')
      await subject.link('wt-link', 'repo-wt')

      await expect(inspector.resolve(at('repo-link'))).resolves.toEqual({
        mineKey: keyIn(subject, 'repo')
      })
      // The workplace is the real path, so both spellings of a worktree stamp one workplace.
      await expect(inspector.resolve(at('wt-link'))).resolves.toEqual({
        mineKey: keyIn(subject, 'repo'),
        workplace: { path: at('repo-wt'), branch: WORKTREE_BRANCH }
      })
    })
  })
}

/** A path under the subject's root, in the subject's style. */
function pathIn(subject: GitRepoInspectorSubject): (...segments: string[]) => string {
  return (...segments) => [subject.root, ...segments].join(separatorOf(subject.style))
}

/** The mine key of a folder under the subject's root (ADR-030 item 1). */
function keyIn(subject: GitRepoInspectorSubject, ...segments: string[]): string {
  return canonicalMinePath(pathIn(subject)(...segments), subject)
}
