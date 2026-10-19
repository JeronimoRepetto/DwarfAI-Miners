// FsGitRepoInspector (05 §3.1, 16 §4.1): the one filesystem-only git inspector that serves the two
// ADR-030 ports, `MineIdentityResolver` (stable: which mine a cwd belongs to) and
// `GitHeadWatchPort` (volatile: the branch or detached HEAD the worktree chip shows).
//
// It reads `.git` files and folders only, through the kernel `FileSystem`, and never starts a
// process: running `git` in a person's repository would run its `core.fsmonitor`, hooks and filters
// (18 T-34). This is the read half of today's `src/main/projects/worktree.ts` (#348), adapted: the
// rule itself is the pure fold of `domain/worktreeFold.ts`, and this adapter gathers the facts it
// decides from:
//
// - the cwd's real path (links, junctions and short names resolved, 18 C-17), and that
//   folder's case-fold decision (`volumeCase.ts`, the S-030-1 detection);
// - the nearest `.git` at or above it, at most 64 folders up; for a `.git` FILE, its `gitdir:`
//   pointer, that folder's `commondir` and `HEAD`, and whether the main working tree the common dir
//   names exists and owns a `.git` DIRECTORY (submodules and bare-repo worktrees never fold).
//
// Anything unreadable answers "own project" (the cwd's own mine, no workplace) or `{ kind: 'none' }`
// and never throws. A resolution is cached per cwd for 30 s (ADR-030 item 4): a repository's layout
// does not change between two poll ticks. `head` re-reads a `HEAD` file only when its mtime changed,
// so a branch switch shows on the next poll of a watched dwarf; where that `HEAD` file lives is
// cached like a resolution.
import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Clock } from '../../../kernel/ports/clock'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import type { Instant } from '../../../kernel/domain/values'
import { HostInvariantError } from '../../../kernel/domain/errors'
import {
  canonicalMinePath,
  caseFoldFor,
  isAbsolutePath,
  type PathStyle,
  type VolumeCase
} from '../domain/minePath'
import {
  commonDirOf,
  gitdirOf,
  mainTreeOf,
  resolveProjectRoot,
  type DotGitFact,
  type MainTreeFact,
  type ProjectRoot
} from '../domain/worktreeFold'
import type { GitHead, GitHeadWatchPort } from '../ports/gitHeadWatchPort'
import type { MineIdentityResolver } from '../ports/mineIdentityResolver'
import { hostVolumeRules } from './volumeCase'

/** How long one cwd's resolution is trusted before the disk is asked again (ADR-030 item 4). */
export const RESOLVER_CACHE_TTL_MS = 30_000

/** How far up from a cwd the walk looks for a `.git` (today's bound, `worktree.ts:49-50`). */
const MAX_WALK_UP = 64

/** Bytes read from `.git`, `commondir` and `HEAD`: each holds one short line. */
const POINTER_MAX_BYTES = 4096

/** The answer outside any repository, or when the repository cannot be read. */
const NO_HEAD: GitHead = { kind: 'none' }

export interface FsGitRepoInspectorDeps {
  /** Read only: the inspector never writes inside a person's repository. */
  readonly fs: Pick<FileSystem, 'stat' | 'readTextHead'>
  readonly clock: Clock
  /** The path rules of the host (`volumeCase.ts`). */
  readonly style: PathStyle
  /** The OS realpath: every link followed to the end; null when nothing is there. */
  realpath(path: string): Promise<string | null>
  /** Whether the folder at a real path compares names without case (the S-030-1 detection). */
  volumeCase(realPath: string): Promise<VolumeCase>
}

/** The nearest `.git` at or above a folder. */
interface GitEntry {
  readonly folder: string
  readonly isDirectory: boolean
}

interface Cached<T> {
  readonly at: Instant
  readonly value: T
}

export class FsGitRepoInspector implements MineIdentityResolver, GitHeadWatchPort {
  private readonly path: typeof win32
  private readonly resolutions = new Map<string, Cached<ProjectRoot>>()
  /** Where each cwd's `HEAD` file is, or null outside a repository. */
  private readonly headFiles = new Map<string, Cached<string | null>>()
  /** Each `HEAD` file's last answer, with the mtime it was read at. */
  private readonly heads = new Map<string, { readonly mtimeMs: number; readonly head: GitHead }>()

  constructor(private readonly deps: FsGitRepoInspectorDeps) {
    this.path = deps.style === 'win32' ? win32 : posix
  }

  /**
   * The mine of a session's cwd (ADR-030 items 1–2). A cwd that is not absolute names no folder
   * and is a programming error (16 §2.1): it is refused before any read, because the OS would
   * resolve it against the Host's own working folder. Every read failure answers its own mine.
   */
  async resolve(cwd: string): Promise<ProjectRoot> {
    if (!isAbsolutePath(cwd, this.deps.style)) {
      throw new HostInvariantError('MineIdentityResolver.resolve needs an absolute cwd')
    }
    const cached = this.fresh(this.resolutions, cwd)
    if (cached !== undefined) return cached
    const resolution = await this.resolveUncached(cwd)
    this.resolutions.set(cwd, { at: this.deps.clock.now(), value: resolution })
    return resolution
  }

  /** The branch or detached commit of the cwd's checkout (ADR-030 item 3); never throws. */
  async head(cwd: string): Promise<GitHead> {
    // A relative cwd names no folder; resolving it would read the Host's own working folder.
    if (!isAbsolutePath(cwd, this.deps.style)) return NO_HEAD
    try {
      let headFile = this.fresh(this.headFiles, cwd)
      if (headFile === undefined) {
        headFile = await this.headFileOf(cwd)
        this.headFiles.set(cwd, { at: this.deps.clock.now(), value: headFile })
      }
      return headFile === null ? NO_HEAD : await this.readHead(headFile)
    } catch {
      return NO_HEAD
    }
  }

  private async resolveUncached(cwd: string): Promise<ProjectRoot> {
    const { style } = this.deps
    let caseFold = caseFoldFor('unknown')
    try {
      const real = (await this.deps.realpath(cwd)) ?? cwd
      caseFold = caseFoldFor(await this.deps.volumeCase(real))
      return resolveProjectRoot({ cwd: real, style, caseFold, dotGit: await this.dotGitAt(real) })
    } catch {
      // Nothing was proved: the cwd stands as its own mine.
      return { mineKey: canonicalMinePath(cwd, { style, caseFold }) }
    }
  }

  /** The nearest `.git` at or above `cwd`, and what the fold needs read beside it. */
  private async dotGitAt(cwd: string): Promise<DotGitFact> {
    const entry = await this.nearestGitEntry(cwd)
    if (entry === null) return { kind: 'none' }
    if (entry.isDirectory) return { kind: 'directory', folder: entry.folder }
    const { style } = this.deps
    const text = await this.readSmall(this.path.join(entry.folder, '.git'))
    const gitdir = gitdirOf(entry.folder, text, style)
    const commondirText =
      gitdir === null ? null : await this.readSmall(this.path.join(gitdir, 'commondir'))
    const headText = gitdir === null ? null : await this.readSmall(this.path.join(gitdir, 'HEAD'))
    const commonDir = gitdir === null ? null : commonDirOf(gitdir, commondirText, style)
    const mainTreePath = commonDir === null ? null : mainTreeOf(commonDir, style)
    const mainTree = mainTreePath === null ? null : await this.mainTreeAt(mainTreePath)
    return { kind: 'file', folder: entry.folder, text, commondirText, headText, mainTree }
  }

  /** The main working tree a common dir names: a directory, its real path, and its `.git` kind. */
  private async mainTreeAt(folder: string): Promise<MainTreeFact | null> {
    const stat = await this.deps.fs.stat(folder)
    if (stat === null || !stat.isDirectory) return null
    const realPath = await this.deps.realpath(folder)
    if (realPath === null) return null
    const git = await this.deps.fs.stat(this.path.join(folder, '.git'))
    return { realPath, hasGitDirectory: git !== null && git.isDirectory }
  }

  /** The `HEAD` file of the checkout holding `cwd`, or null outside a repository. */
  private async headFileOf(cwd: string): Promise<string | null> {
    const real = (await this.deps.realpath(cwd)) ?? cwd
    const entry = await this.nearestGitEntry(real)
    if (entry === null) return null
    if (entry.isDirectory) return this.path.join(entry.folder, '.git', 'HEAD')
    const text = await this.readSmall(this.path.join(entry.folder, '.git'))
    const gitdir = gitdirOf(entry.folder, text, this.deps.style)
    return gitdir === null ? null : this.path.join(gitdir, 'HEAD')
  }

  /** A `HEAD` file's answer, read again only when its mtime changed (ADR-030 item 4). */
  private async readHead(headFile: string): Promise<GitHead> {
    const stat = await this.deps.fs.stat(headFile)
    if (stat === null || stat.isDirectory) return NO_HEAD
    const known = this.heads.get(headFile)
    if (known !== undefined && known.mtimeMs === stat.mtimeMs) return known.head
    const head = gitHeadOf(await this.readSmall(headFile))
    this.heads.set(headFile, { mtimeMs: stat.mtimeMs, head })
    return head
  }

  /** Walks up because a session may start in a subfolder of its checkout; bounded. */
  private async nearestGitEntry(cwd: string): Promise<GitEntry | null> {
    let folder = cwd
    for (let step = 0; step < MAX_WALK_UP; step++) {
      const stat = await this.deps.fs.stat(this.path.join(folder, '.git'))
      if (stat !== null) return { folder, isDirectory: stat.isDirectory }
      const parent = this.path.dirname(folder)
      if (parent === folder) return null
      folder = parent
    }
    return null
  }

  /** One short pointer file, or null for anything that could not be read. */
  private async readSmall(path: string): Promise<string | null> {
    try {
      return await this.deps.fs.readTextHead(path, POINTER_MAX_BYTES)
    } catch {
      return null
    }
  }

  private fresh<T>(cache: Map<string, Cached<T>>, cwd: string): T | undefined {
    const cached = cache.get(cwd)
    if (cached === undefined) return undefined
    return this.deps.clock.now() - cached.at < RESOLVER_CACHE_TTL_MS ? cached.value : undefined
  }
}

/**
 * The Host's inspector: the kernel ports from the composition root, the OS realpath and the host
 * OS's path rules (`volumeCase.ts`). Composed by the mines wiring (ISSUE-068, ISSUE-093).
 */
export function createHostGitRepoInspector(deps: {
  readonly fs: Pick<FileSystem, 'stat' | 'readTextHead'>
  readonly clock: Clock
}): FsGitRepoInspector {
  const rules = hostVolumeRules(deps.clock)
  return new FsGitRepoInspector({
    fs: deps.fs,
    clock: deps.clock,
    style: rules.style,
    realpath: (path) => realpath(path).then(String, () => null),
    volumeCase: rules.volumeCase
  })
}

/**
 * What a `HEAD` file says: a branch, or the short commit of a detached one. Anything else is
 * `none`: absent is honest, and a wrong branch name on the chip is not.
 */
function gitHeadOf(text: string | null): GitHead {
  const line = text?.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(line)?.[1]?.trim()
  if (branch !== undefined && branch !== '') return { kind: 'branch', name: branch }
  return /^[0-9a-f]{40,}$/i.test(line) ? { kind: 'detached', shortSha: line.slice(0, 7) } : NO_HEAD
}
