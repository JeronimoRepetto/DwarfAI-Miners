// The per-OS path rules of the git inspector (ADR-030 item 1, S-030-1): which separators a path
// follows and whether a volume compares paths without case. R18: the running OS is read here, in an
// adapter, and nowhere in the domain; every other function takes the OS as a value, so a macOS or
// Linux rule is asserted on any host.
//
// S-030-1 (detecting case-insensitive volumes on macOS and Linux cheaply) has no passed record, so
// the conservative default of `21` §2 cut 1 holds: a macOS or Linux volume is `unknown` and is
// never folded (`caseFoldFor`). Folding a case-sensitive volume would merge two different folders
// into one mine; not folding a case-insensitive one only risks a second mine for an odd spelling,
// and the real path already gives one spelling per folder in the common case. When S-030-1
// passes, its detection replaces the `unknown` answer here and nothing else changes.
import type { PathStyle, VolumeCase } from '../domain/minePath'

/** The operating systems the Host runs on (every other POSIX host follows Linux's rules). */
export type HostOs = 'win32' | 'darwin' | 'linux'

/** How paths compare on one OS. */
export interface VolumeRules {
  readonly style: PathStyle
  /** What is known about the case sensitivity of the volume holding `realPath`. */
  volumeCase(realPath: string): Promise<VolumeCase>
}

/** The path rules of `os`. */
export function volumeRulesFor(os: HostOs): VolumeRules {
  if (os === 'win32') {
    // NTFS and ReFS compare names without case; ADR-030 item 1 folds every Windows path.
    return { style: 'win32', volumeCase: () => Promise.resolve('case-insensitive') }
  }
  // S-030-1 not passed: no detection, so no folding (the conservative default).
  return { style: 'posix', volumeCase: () => Promise.resolve('unknown') }
}

/** The path rules of the OS the Host runs on. */
export function hostVolumeRules(): VolumeRules {
  return volumeRulesFor(hostOs())
}

function hostOs(): HostOs {
  const running = process.platform
  return running === 'win32' || running === 'darwin' ? running : 'linux'
}
