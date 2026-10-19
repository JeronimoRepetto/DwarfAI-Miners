// `MinesQueries.resolveFileInMine` (05 §3.1, 16 §4.1; 14 §1.10 `openMinePath`; ADR-019 item 9;
// 18 C-17, T-35): a target an activity line names, resolved inside its mine's folder, or refused.
// Read-only: no transaction, no event.
//
// Replaces today's `openMineFile.ts` rule (21 §6), which normalizes `..` from the spelling and then
// compares strings, so a link or junction inside the mine that points out of it was admitted. Here
// the OS decides where a spelling leads, and only that answer is compared:
//
// - A relative target is joined to the mine's folder; an absolute one stands as is. Neither is
//   normalized first: `link/..` is the parent of the link's TARGET on POSIX, and only the OS
//   realpath knows that (on Windows the OS itself drops `..` before opening, and so does its
//   realpath). Removing `..` here would admit `link/../secret` as a file of the mine.
// - On Windows a UNC or device target (`\\server\share`, `\\.\pipe`, `\\?\`) is refused before any
//   read: resolving it would open a network connection with the person's credentials.
// - The target's real path must be the mine folder's real path or lie under it, at a separator
//   (`mine` never admits `mineEvil`). Both sides come from the same OS realpath, so they are
//   compared exactly: a case difference can only refuse, never admit.
// - The answer is that real path, so what is opened is what was checked. Nothing there, a link to
//   nothing, or an entry that is neither a file nor a folder (a FIFO, a device, a socket: nothing a
//   person opens, T-35) is `missing`; so is a mine that is unknown or removed (no folder to resolve
//   against). The two outcomes are the frozen contract's only ones.
//
// `MinesQueries` is synchronous (16 §4.1), so the probe is too: the kernel `FileSystem` (16 §3)
// is asynchronous and has no realpath. Its adapter is `adapters/pathValidation.ts`.
import type { FolderPath, MineId, Result } from '../../../kernel/domain/values'
import { isAbsolutePath, separatorOf, type PathStyle } from '../domain/minePath'
import type { MineRepository } from '../ports/mineRepository'

/** What an entry of the file system is, at its real path. */
export type EntryKind = 'directory' | 'file' | 'other'

/** The OS's own answers about a path, read synchronously (C-17). */
export interface MinePathProbe {
  /**
   * The OS realpath: every link and junction followed, `.` and `..` taken as the OS takes them;
   * null when nothing is there or it cannot be read. Never throws.
   */
  realpath(path: string): string | null
  /** What is at a real path, links not followed; null when nothing is there. Never throws. */
  kindOf(realPath: string): EntryKind | null
}

export interface ResolveFileDeps {
  readonly repository: Pick<MineRepository, 'byId'>
  readonly paths: MinePathProbe
  /** The Host's path rules (`volumeCase.ts`). */
  readonly style: PathStyle
}

/** The real path of `target` inside the mine `mineId`, or why there is none. */
export function resolveFileInMine(
  deps: ResolveFileDeps,
  mineId: MineId,
  target: string
): Result<FolderPath, 'escapes-mine' | 'missing'> {
  const { style } = deps
  if (style === 'win32' && isUncOrDevice(target)) return refused('escapes-mine')
  const mine = deps.repository.byId(mineId)
  if (mine === null || mine.state === 'removed') return refused('missing')

  const sep = separatorOf(style)
  const folder = deps.paths.realpath(mine.path)
  if (folder === null) return refused('missing')
  const spelled = isAbsolutePath(target, style) ? target : `${mine.path}${sep}${target}`
  const real = deps.paths.realpath(spelled)
  if (real === null) return refused('missing')

  const under = folder.endsWith(sep) ? folder : `${folder}${sep}`
  if (real !== folder && !real.startsWith(under)) return refused('escapes-mine')
  const kind = deps.paths.kindOf(real)
  if (kind !== 'file' && kind !== 'directory') return refused('missing')
  return { ok: true, value: real as FolderPath }
}

/** A Windows path that starts with two separators: UNC (`\\server`), device (`\\.\`, `\\?\`). */
function isUncOrDevice(target: string): boolean {
  return /^[\\/]{2}/.test(target)
}

function refused(error: 'escapes-mine' | 'missing'): { ok: false; error: typeof error } {
  return { ok: false, error }
}
