// The worktree fold (ADR-030 item 2, 06 INV-03): which mine a session's cwd belongs to, decided
// from the `.git` facts the inspector reads (ISSUE-064). Pure: no file-system read, no `git`.
//
// The rule is today's `resolveProjectRoot` (`src/main/projects/worktree.ts`, #348), unchanged in
// behaviour and split from its reads, with HR W1's fix (separators normalized before any path
// segment test):
//
// - The mine is the exact cwd. A subfolder of a checkout is its own mine: nothing walks up to a
//   parent, except a linked worktree.
// - A linked worktree's `.git` is a FILE holding `gitdir: <main>/.git/worktrees/<name>`; that
//   folder holds `commondir` (normally `../..`) naming the common `.git`, whose parent is the main
//   working tree. The worktree folds onto that tree, whether or not its mine exists yet, and the
//   session keeps its own cwd as its workplace.
// - A submodule's `.git` file points under `.git/modules/`, where git writes no `commondir`: no
//   fold. A worktree of a bare repository has a common dir that is not a `.git` folder of a
//   checkout: no fold. The main tree must also own a `.git` DIRECTORY (today's guard).
// - Anything unreadable, absent or unrecognised answers the cwd itself: a detection that cannot
//   prove a fold never invents one.
import {
  canonicalMinePath,
  isAbsolutePath,
  normalizeSeparators,
  separatorOf,
  type MinePath,
  type PathStyle
} from './minePath'

/** The main working tree a common dir names, as the inspector found it. */
export interface MainTreeFact {
  /** Real path of the common dir's parent folder (it exists and is a directory). */
  readonly realPath: string
  /** Whether that folder owns a `.git` directory (a separate-git-dir checkout has a `.git` file). */
  readonly hasGitDirectory: boolean
}

/** The nearest `.git` at or above the cwd, and what the inspector read beside it. */
export type DotGitFact =
  /** No `.git` found within the inspector's bounded walk, or it could not be read. */
  | { readonly kind: 'none' }
  /** A `.git` directory: a main working tree or a folder inside one (`folder` holds the `.git`). */
  | { readonly kind: 'directory'; readonly folder: string }
  /** A `.git` file: a linked worktree, a submodule, or something unrecognised. */
  | {
      readonly kind: 'file'
      /** The folder holding the `.git` file; a relative `gitdir:` pointer resolves against it. */
      readonly folder: string
      /** The `.git` file's text, or null when unreadable. */
      readonly text: string | null
      /** The text of `<gitdir>/commondir` (see `gitdirOf`), or null when absent or unreadable. */
      readonly commondirText: string | null
      /** The text of `<gitdir>/HEAD`, or null when absent or unreadable. */
      readonly headText: string | null
      /** The folder `mainTreeOf(commonDir)` names, or null when absent or not a directory. */
      readonly mainTree: MainTreeFact | null
    }

export interface WorktreeFacts {
  /** The session's cwd, as its real path. */
  readonly cwd: string
  readonly style: PathStyle
  /** The volume's case-fold decision (`caseFoldFor`). */
  readonly caseFold: boolean
  readonly dotGit: DotGitFact
}

/**
 * Where a dwarf works when that is not its mine's own folder (06 §4.1, ADR-030): present only for a
 * linked worktree; `branch` absent means a detached HEAD (the chip names the folder instead).
 */
export interface DwarfWorkplace {
  readonly path: string
  readonly branch?: string
}

/** The answer of `MineIdentityResolver.resolve` (ADR-030 item 3). */
export interface ProjectRoot {
  readonly mineKey: MinePath
  readonly workplace?: DwarfWorkplace
}

/** The mine of a session's cwd: the cwd itself, or the main working tree of a linked worktree. */
export function resolveProjectRoot(facts: WorktreeFacts): ProjectRoot {
  const own: ProjectRoot = { mineKey: canonicalMinePath(facts.cwd, facts) }
  const git = facts.dotGit
  // A `.git` directory: the cwd is already a project, or a folder inside one, and stands as is.
  if (git.kind !== 'file') return own

  const gitdir = gitdirOf(git.folder, git.text, facts.style)
  if (gitdir === null) return own
  // The tell between a worktree and a submodule: `commondir` exists under `.git/worktrees/<name>`
  // and never under `.git/modules/<name>`.
  const commonDir = commonDirOf(gitdir, git.commondirText, facts.style)
  if (commonDir === null || mainTreeOf(commonDir, facts.style) === null) return own
  // A bare repository's folder is a directory too: only one owning a `.git` DIRECTORY is a tree.
  if (git.mainTree === null || !git.mainTree.hasGitDirectory) return own

  const mineKey = canonicalMinePath(git.mainTree.realPath, facts)
  // Nothing folds onto itself.
  if (mineKey === own.mineKey) return own
  const branch = branchOf(git.headText)
  return { mineKey, workplace: branch === null ? { path: facts.cwd } : { path: facts.cwd, branch } }
}

/**
 * The administrative folder a `.git` file points at (`gitdir: <path>`), absolute and with
 * separators normalized, or null when the text is unreadable or no pointer. The inspector reads
 * `commondir` and `HEAD` inside it.
 */
export function gitdirOf(folder: string, text: string | null, style: PathStyle): string | null {
  const line = firstLine(text)
  const pointer = line === null ? null : /^gitdir:\s*(.+)$/.exec(line)?.[1]?.trim()
  if (pointer === undefined || pointer === null || pointer === '') return null
  return absolute(pointer, folder, style)
}

/** The common `.git` a worktree's `commondir` names, absolute, or null when there is none. */
export function commonDirOf(
  gitdir: string,
  commondirText: string | null,
  style: PathStyle
): string | null {
  const line = firstLine(commondirText)
  return line === null ? null : absolute(line, gitdir, style)
}

/**
 * The main working tree a common dir belongs to: its parent, when the common dir is a `.git`
 * folder (a segment test, so separators are normalized first, HR W1). Null for a bare
 * repository (`repo.git`) or a submodule's own common dir (`.git/modules/<name>`). The inspector
 * stats this folder and its `.git` for `MainTreeFact`.
 */
export function mainTreeOf(commonDir: string, style: PathStyle): string | null {
  const segments = splitSegments(commonDir, style)
  const last = segments.at(-1)
  const isDotGit = style === 'win32' ? last?.toLowerCase() === '.git' : last === '.git'
  if (!isDotGit || segments.length < 2) return null
  return joinSegments(segments.slice(0, -1), commonDir, style)
}

/** The branch a `HEAD` names, or null for a detached or unrecognised one (never a guess). */
function branchOf(headText: string | null): string | null {
  const line = firstLine(headText)
  const branch = line === null ? undefined : /^ref:\s*refs\/heads\/(.+)$/.exec(line)?.[1]?.trim()
  return branch === undefined || branch === '' ? null : branch
}

function firstLine(text: string | null): string | null {
  if (text === null) return null
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return line === '' ? null : line
}

/** A pointer made absolute against the folder that named it, `.` and `..` resolved. */
function absolute(path: string, from: string, style: PathStyle): string {
  const base = isAbsolutePath(path, style) ? path : `${from}${separatorOf(style)}${path}`
  const resolved: string[] = []
  for (const segment of splitSegments(base, style)) {
    if (segment === '.') continue
    if (segment === '..') {
      // Never above the root segment (a drive or the UNC host on Windows, '' on POSIX).
      if (resolved.length > 1) resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return joinSegments(resolved, base, style)
}

/** Segments of an absolute path; on POSIX the first is '' (the root). */
function splitSegments(path: string, style: PathStyle): string[] {
  const normalized = normalizeSeparators(path, style)
  const unc = style === 'win32' && normalized.startsWith('\\\\')
  const body = unc ? normalized.slice(2) : normalized
  return body.split(separatorOf(style)).filter((segment, index) => index === 0 || segment !== '')
}

function joinSegments(segments: readonly string[], original: string, style: PathStyle): string {
  const sep = separatorOf(style)
  const unc = style === 'win32' && normalizeSeparators(original, style).startsWith('\\\\')
  const joined = segments.join(sep)
  if (unc) return `\\\\${joined}`
  // A lone root segment ('' on POSIX, 'C:' on Windows) keeps its separator.
  return segments.length === 1 ? `${joined}${sep}` : joined
}
