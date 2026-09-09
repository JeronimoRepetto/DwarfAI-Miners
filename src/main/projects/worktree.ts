import { posix, win32 } from 'node:path'
import type { FsLike } from '../adapters/fsLike'
import type { DwarfWorkplace, ProviderSnapshot } from '../domain/types'
import { currentPlatform, normalizePathKey, type Platform } from '../platform/platform'

/**
 * Which project one session's cwd belongs to — folding every worktree of a
 * repository onto its main working tree (#348).
 *
 * A person running several agents on one codebase opens one worktree per
 * terminal. Keyed by cwd, that is five mines for one project, and the board is
 * a map of projects rather than of folders. So the mine is the main working
 * tree and the dwarf carries the worktree it is actually in.
 *
 * ## Why no git binary
 *
 * The layout on disk states the answer outright, and reading it costs two
 * small files:
 *
 * - A linked worktree's `.git` is a FILE holding `gitdir: <path>`, pointing at
 *   `<main>/.git/worktrees/<name>`. A main working tree's `.git` is a
 *   DIRECTORY, which is the whole test for "this is already a project".
 * - Inside that administrative directory, `commondir` holds a path (normally
 *   `../..`) to the repository's common `.git`; its parent is the main working
 *   tree.
 * - `HEAD` beside it names the branch the worktree has checked out.
 *
 * Shelling out to `git worktree list` would need the binary on PATH, a process
 * per session per poll, and a platform port for the spawn — for a fact three
 * text files already carry.
 *
 * ## What must never fold
 *
 * A **submodule** also has a `.git` file, pointing at
 * `<super>/.git/modules/<name>` — and there is no `commondir` under
 * `modules/`, which is the tell. A submodule is a different repository that
 * happens to live inside another checkout, so folding it would merge two
 * projects.
 *
 * A worktree of a **bare** repository has no main working tree to fold onto:
 * the common dir's parent is whatever folder the bare repo sits in, which is
 * not a checkout of anything. Both are refused by the same two guards — the
 * parent must exist as a directory AND own a `.git` directory of its own.
 *
 * Anything unreadable, absent or unrecognised answers "this folder is its own
 * project", which is exactly the behaviour before this issue: a detection that
 * cannot prove a fold must never invent one.
 */

/** node:path's OS-specific submodule for `platform` — never the running host's (see platform-ports). */
function pathFor(platform: Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** How far up from a cwd the walk looks for a `.git`, before giving up. */
const MAX_WALK_UP = 64

/** Bytes read from `.git`, `commondir` and `HEAD` — each holds one short line. */
const POINTER_MAX_BYTES = 4096

/** How long one cwd's answer is trusted before the disk is asked again. */
const DEFAULT_TTL_MS = 30_000

/**
 * Where one session works, as the resolver reads it off disk.
 *
 * Richer than the `DwarfWorkplace` that reaches the wire by exactly one field:
 * `commit` exists for a DETACHED worktree, which has no branch to name. The
 * message panel deliberately does not carry it (a short sha is not a name a
 * person navigates by), but the Add dialog does — that is the one place a
 * person is being asked about this exact folder, and "on branch <nothing>"
 * would be worse than the sha.
 */
export interface ProjectWorktree {
  /** The session's own cwd, never the worktree's top folder — see DwarfWorkplace.path. */
  path: string
  /** The branch this worktree has checked out; absent when its HEAD is detached. */
  branch?: string
  /** The short commit sha, and only when HEAD is detached. */
  commit?: string
}

/**
 * The project one cwd belongs to, and the worktree it sits in when those are
 * two different places.
 *
 * `worktree` absent means the cwd IS its own project — a main working tree, a
 * folder inside one, a submodule, or no repository at all. In every one of
 * those cases `root` is the cwd unchanged, so a caller can use `root`
 * unconditionally and never has to ask whether folding happened.
 */
export interface ProjectRootResolution {
  root: string
  worktree?: ProjectWorktree
}

/**
 * Which project a cwd belongs to, read off the filesystem (#348).
 *
 * Two stats and two small reads in the folding case; one stat per ancestor and
 * nothing else where there is no repository. Never throws: every read is
 * guarded, and every failure answers with the cwd itself.
 */
export async function resolveProjectRoot(
  cwd: string,
  fs: FsLike,
  platform: Platform = currentPlatform()
): Promise<ProjectRootResolution> {
  const unfolded: ProjectRootResolution = { root: cwd }
  const p = pathFor(platform)

  const entry = await nearestGitEntry(cwd, fs, p)
  // A main working tree's `.git` is a directory, and so is a bare repo's
  // checkout: either way this folder is already a project, and the cwd stands
  // exactly as it did before this issue. Deliberately NOT the folder holding
  // the `.git` — a session started in a subfolder of a project has always been
  // its own mine, and quietly folding those too would be a second, unasked
  // change to what the board shows.
  if (entry === null || entry.isDirectory) return unfolded

  const pointer = parseGitdirPointer(await readSmallFile(fs, entry.path))
  if (pointer === null) return unfolded
  const gitdir = absolute(pointer, entry.folder, p)

  // The tell that separates a worktree from a submodule: `commondir` exists
  // under `.git/worktrees/<name>` and never under `.git/modules/<name>`.
  const common = parseFirstLine(await readSmallFile(fs, p.join(gitdir, 'commondir')))
  if (common === null) return unfolded
  const root = p.dirname(absolute(common, gitdir, p))

  // Both guards, not one. The parent of a common dir is a real directory for a
  // BARE repository too — it is simply the folder the bare repo was cloned
  // into, and nobody works there. Only a folder with a `.git` DIRECTORY of its
  // own is a main working tree.
  const rootStat = await fs.stat(root)
  if (rootStat === null || !rootStat.isDirectory) return unfolded
  const rootGit = await fs.stat(p.join(root, '.git'))
  if (rootGit === null || !rootGit.isDirectory) return unfolded
  // Nothing folds onto itself: a resolution whose root is the cwd would stamp
  // every dwarf with a workplace that says nothing.
  if (normalizePathKey(root, platform) === normalizePathKey(cwd, platform)) return unfolded

  const head = parseHead(await readSmallFile(fs, p.join(gitdir, 'HEAD')))
  return { root, worktree: { path: cwd, ...head } }
}

/** One cwd's resolution, cached — see createProjectRootResolver. */
export interface ProjectRootResolver {
  resolve(cwd: string): Promise<ProjectRootResolution>
}

export interface ProjectRootResolverOptions {
  fs: FsLike
  platform?: Platform
  now?: () => number
  /** How long one answer is trusted; defaults to 30 seconds. */
  ttlMs?: number
}

/**
 * The resolver the poll loop uses: the same answer, cached per cwd (#348).
 *
 * The poll runs at 2Hz over every session on the machine, and re-reading three
 * files per session per tick is a disk cost nobody asked for — the layout of a
 * repository does not change between two ticks.
 *
 * It is not cached FOREVER either, and the window is why: what a cached entry
 * can get wrong is the branch, because switching branches inside a worktree is
 * an ordinary thing to do while the panel is open, and the header would go on
 * naming the old one. A window also re-answers the rarer structural changes —
 * a folder that has just become a worktree, or one whose worktree was
 * removed — without a single special case for either.
 *
 * Keyed by the platform's own path key, so two spellings of one folder share
 * one entry rather than paying twice (see normalizePathKey).
 */
export function createProjectRootResolver(
  options: ProjectRootResolverOptions
): ProjectRootResolver {
  const platform = options.platform ?? currentPlatform()
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<string, { at: number; resolution: ProjectRootResolution }>()

  return {
    async resolve(cwd: string): Promise<ProjectRootResolution> {
      const key = normalizePathKey(cwd, platform)
      const cached = cache.get(key)
      const at = now()
      if (cached !== undefined && at - cached.at < ttlMs) return cached.resolution
      const resolution = await resolveProjectRoot(cwd, options.fs, platform)
      cache.set(key, { at, resolution })
      return resolution
    }
  }
}

/**
 * Rewrite one poll's snapshots so a worktree session is grouped under its
 * project, and its dwarfs remember where they actually are (#348).
 *
 * Pure, and applied at the ONE seam where a cwd becomes a mine path — just
 * before `aggregateMines`, rather than inside each provider. Every provider
 * reports the cwd its own store recorded and none of them knows what a
 * worktree is; teaching four scanners the same rule is four places for it to
 * drift, and the aggregate is where "which project is this" is already
 * answered.
 *
 * `resolutionOf` is a LOOKUP, not a read: the disk work happened before this
 * call, so this step stays synchronous and testable with no fake filesystem at
 * all. A cwd it has no answer for is left exactly as it was.
 *
 * The input is never mutated, and a poll with nothing to fold comes back as
 * itself — the same discipline every composed step in aggregate.ts holds.
 */
export function foldWorktreeSnapshots(
  snapshots: ProviderSnapshot[],
  resolutionOf: (cwd: string) => ProjectRootResolution | undefined
): ProviderSnapshot[] {
  let folded = false
  const output = snapshots.map((snapshot) => {
    const worktree = resolutionOf(snapshot.cwd)?.worktree
    const root = resolutionOf(snapshot.cwd)?.root
    if (worktree === undefined || root === undefined) return snapshot
    folded = true
    // `commit` is dropped here rather than in the resolver: it is real, and the
    // Add dialog uses it — the wire for a DWARF just does not carry it.
    const workplace: DwarfWorkplace = {
      path: worktree.path,
      ...(worktree.branch === undefined ? {} : { branch: worktree.branch })
    }
    return {
      ...snapshot,
      cwd: root,
      dwarfs: snapshot.dwarfs.map((dwarf) => ({ ...dwarf, workplace }))
    }
  })
  return folded ? output : snapshots
}

/**
 * The nearest `.git` at or above a cwd, and whether it is a directory.
 *
 * Walks up because the cwd may be a subfolder of the worktree — a session
 * started in `<worktree>/src` is in that worktree just as much as one started
 * at its top. Bounded, so a pathological path cannot spin.
 */
async function nearestGitEntry(
  cwd: string,
  fs: FsLike,
  p: typeof posix
): Promise<{ folder: string; path: string; isDirectory: boolean } | null> {
  let folder = p.normalize(cwd)
  for (let step = 0; step < MAX_WALK_UP; step++) {
    const path = p.join(folder, '.git')
    const stat = await fs.stat(path)
    if (stat !== null) return { folder, path, isDirectory: stat.isDirectory }
    const parent = p.dirname(folder)
    if (parent === folder) return null
    folder = parent
  }
  return null
}

/** One short pointer file, or null for anything that could not be read. */
async function readSmallFile(fs: FsLike, path: string): Promise<string | null> {
  try {
    return await fs.readTextHead(path, POINTER_MAX_BYTES)
  } catch {
    // Missing, unreadable, or a `.git` file pointing outside the filesystem it
    // describes. All three mean the same thing here: nothing was proved.
    return null
  }
}

function parseGitdirPointer(content: string | null): string | null {
  const line = parseFirstLine(content)
  if (line === null) return null
  const match = /^gitdir:\s*(.+)$/.exec(line)
  return match === null ? null : match[1]!.trim()
}

function parseFirstLine(content: string | null): string | null {
  if (content === null) return null
  const line = content.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return line === '' ? null : line
}

/** A path from a pointer file, made absolute against the folder that named it. */
function absolute(path: string, from: string, p: typeof posix): string {
  return p.normalize(p.isAbsolute(path) ? path : p.join(from, path))
}

/**
 * What a worktree's own HEAD says: a branch, or the short commit of a detached
 * one. Neither, where the file says something this app does not recognise —
 * absent is honest, and a wrong branch name on the panel is not.
 */
function parseHead(content: string | null): { branch?: string; commit?: string } {
  const line = parseFirstLine(content)
  if (line === null) return {}
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(line)
  if (ref !== null) return { branch: ref[1]!.trim() }
  return /^[0-9a-f]{40,}$/i.test(line) ? { commit: line.slice(0, 7) } : {}
}
