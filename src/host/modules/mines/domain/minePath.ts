// A mine's identity: the canonical form of its exact working folder (ADR-030 item 1, 06 §3, INV-02).
// Pure: the real path and the case-fold decision are inputs; the file-system reads behind them are
// the inspector's (ISSUE-064). No `node:path` here (R1), so the few path rules live below.
import { HostInvariantError } from '../../../kernel/domain/errors'

/** Which separator rules a path follows. On POSIX a backslash is a filename character. */
export type PathStyle = 'win32' | 'posix'

/** What the inspector knows about a volume's case sensitivity (S-030-1). */
export type VolumeCase = 'case-insensitive' | 'case-sensitive' | 'unknown'

/** `canonicalMinePath(p)` of a mine's folder: the mine's identity, unique across all mines (INV-02). */
export type MinePath = string & { readonly __brand: 'MinePath' }

export interface CanonicalPathOptions {
  readonly style: PathStyle
  /** Whether case is folded for this folder's volume: see `caseFoldFor`. */
  readonly caseFold: boolean
}

/**
 * Whether paths on a volume compare without case (ADR-030 item 1): always on Windows; on POSIX only
 * for a volume known to be case-insensitive. An unknown volume is never folded: folding a
 * case-sensitive volume would merge two different folders into one mine, while not folding a
 * case-insensitive one only risks a second mine for an odd spelling (the conservative default of
 * `21` §2 cut 1 while S-030-1 has not passed).
 */
export function caseFoldFor(style: PathStyle, volume: VolumeCase): boolean {
  return style === 'win32' || volume === 'case-insensitive'
}

/**
 * The canonical form of a folder's real path (ADR-030 item 1): separators normalized, trailing
 * separator removed (a root keeps its own), and case folded when `caseFold` says so. Two
 * spellings of one folder give one `MinePath`; resolving the real path (symlinks, junctions,
 * dev+ino) is the caller's input. A path that is not absolute is a programming error.
 */
export function canonicalMinePath(realPath: string, options: CanonicalPathOptions): MinePath {
  if (!isAbsolutePath(realPath, options.style)) {
    throw new HostInvariantError('canonicalMinePath needs an absolute real path')
  }
  const normalized = normalizeSeparators(realPath, options.style)
  const trimmed = stripTrailingSeparator(normalized, options.style)
  return (options.caseFold ? trimmed.toLowerCase() : trimmed) as MinePath
}

/** The separator a style writes. */
export function separatorOf(style: PathStyle): '\\' | '/' {
  return style === 'win32' ? '\\' : '/'
}

/** Whether a path is absolute: a drive (`C:\`) or a UNC prefix on Windows, a leading `/` on POSIX. */
export function isAbsolutePath(path: string, style: PathStyle): boolean {
  if (style === 'posix') return path.startsWith('/')
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)
}

/**
 * One separator between segments (HR W1: on Windows both `/` and `\` become `\` before any
 * segment test). A Windows UNC path keeps its two leading separators.
 */
export function normalizeSeparators(path: string, style: PathStyle): string {
  if (style === 'posix') return path.replace(/\/{2,}/g, '/')
  const unified = path.replace(/\//g, '\\')
  const unc = /^\\\\[^\\]/.test(unified)
  const collapsed = unified.replace(/\\{2,}/g, '\\')
  return unc ? `\\${collapsed}` : collapsed
}

function stripTrailingSeparator(path: string, style: PathStyle): string {
  const sep = separatorOf(style)
  if (!path.endsWith(sep) || isRoot(path, style)) return path
  return path.slice(0, -1)
}

function isRoot(path: string, style: PathStyle): boolean {
  return style === 'posix' ? path === '/' : /^[A-Za-z]:\\$/.test(path)
}
