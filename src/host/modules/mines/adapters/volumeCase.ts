// The per-OS path rules of the git inspector (ADR-030 item 1, S-030-1): which separators a path
// follows and whether a folder compares names without case. R18: the running OS is read here, in an
// adapter, and nowhere in the domain; every other function takes the OS as a value, so a macOS or
// Linux rule is asserted on any host.
//
// S-030-1 passed (spike-results/S-030-1.md, Decision). On every OS the answer comes from the folder
// itself, never from the OS name: take the nearest component of the real path whose name has a
// cased letter, swap the case of that name, and stat both spellings in the same parent directory.
// The same file (device and inode, read as bigint so a 64-bit NTFS file index keeps its precision)
// means that directory folds case; a missing or different file means it does not. Nothing to
// probe, or a path that cannot be read, answers `unknown`, which never folds (`caseFoldFor`).
// Windows follows the same rule: an NTFS folder with the per-directory case-sensitive flag does
// not fold, although ADR-030 item 1 still reads "case-folded on Windows" (the record flags it for
// the lead). Two `stat` calls, no write and no spawn.
//
// The answer belongs to the directory that holds the probed name: ext4 `casefold` is a
// per-directory attribute, so one device can hold folding and non-folding folders. It is cached
// per that directory's path, never per device, for the resolver's lifetime (ADR-030 item 4).
// Known limit, accepted by the record: the mine key is folded as a whole.
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Instant } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { PathStyle, VolumeCase } from '../domain/minePath'

/** How long a directory's answer is trusted: the resolver cache's lifetime (ADR-030 item 4). */
export const VOLUME_CASE_TTL_MS = 30_000

/** The operating systems the Host runs on (every other POSIX host follows Linux's rules). */
export type HostOs = 'win32' | 'darwin' | 'linux'

/** A file's identity on its volume. */
export interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

/** A path's identity, or null when nothing is there or it cannot be read. */
export type IdentityReader = (path: string) => Promise<FileIdentity | null>

export interface VolumeCaseDeps {
  readonly identityOf: IdentityReader
  readonly clock: Clock
}

/** How paths compare on one OS. */
export interface VolumeRules {
  readonly style: PathStyle
  /** Whether the folder at `realPath` (an absolute real path) compares names without case. */
  volumeCase(realPath: string): Promise<VolumeCase>
}

/** The path rules of `os`, probing folders through `deps.identityOf`. */
export function volumeRulesFor(os: HostOs, deps: VolumeCaseDeps): VolumeRules {
  const style: PathStyle = os === 'win32' ? 'win32' : 'posix'
  const path = style === 'win32' ? win32 : posix
  const answers = new Map<string, { readonly at: Instant; readonly value: VolumeCase }>()

  return {
    style,
    async volumeCase(realPath) {
      const probed = nearestCasedComponent(realPath, path)
      if (probed === null) return 'unknown'
      const directory = path.dirname(probed)
      const cached = answers.get(directory)
      if (cached !== undefined && deps.clock.now() - cached.at < VOLUME_CASE_TTL_MS) {
        return cached.value
      }
      const original = await deps.identityOf(probed)
      // Unreadable: not an answer about the directory, so it is not cached.
      if (original === null) return 'unknown'
      const other = await deps.identityOf(path.join(directory, swapCase(path.basename(probed))))
      const folds = other !== null && other.dev === original.dev && other.ino === original.ino
      const value: VolumeCase = folds ? 'case-insensitive' : 'case-sensitive'
      answers.set(directory, { at: deps.clock.now(), value })
      return value
    }
  }
}

/** The path rules of the OS the Host runs on, probing the real file system. */
export function hostVolumeRules(clock: Clock): VolumeRules {
  return volumeRulesFor(hostOs(), { identityOf: statIdentity, clock })
}

/** A path's device and inode, read as bigint; null when it is missing or cannot be read. */
export async function statIdentity(path: string): Promise<FileIdentity | null> {
  try {
    const stats = await stat(path, { bigint: true })
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return null
  }
}

/** The path itself or its nearest ancestor whose name has a cased letter, or null for none. */
function nearestCasedComponent(realPath: string, path: typeof posix): string | null {
  for (let current = realPath; ; current = path.dirname(current)) {
    const name = path.basename(current)
    if (name !== '' && swapCase(name) !== name) return current
    if (path.dirname(current) === current) return null
  }
}

function swapCase(name: string): string {
  return [...name]
    .map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()))
    .join('')
}

function hostOs(): HostOs {
  const running = process.platform
  return running === 'win32' || running === 'darwin' ? running : 'linux'
}
