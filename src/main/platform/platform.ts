/**
 * The platform families DwarfAI-Miners ships adapters for, and the few pure
 * path rules that differ between them.
 *
 * Everything else per-OS lives behind a port selected once in
 * platformAdapters.ts — this module carries only the vocabulary those ports
 * share, so it can be imported from anywhere without pulling an adapter in.
 */

/** A platform family with its own adapter set. */
export type Platform = 'win32' | 'darwin' | 'linux'

/**
 * Map a raw `process.platform` value onto a supported family.
 *
 * Anything that is not Windows or macOS is treated as Linux — the generic
 * POSIX adapters (pgrep, /bin/sh, XDG autostart) are the right best effort on
 * every other Unix, and they already degrade to an honest "unsupported"
 * wherever they cannot actually deliver.
 */
export function normalizePlatform(raw: string): Platform {
  if (raw === 'win32') return 'win32'
  if (raw === 'darwin') return 'darwin'
  return 'linux'
}

/** The family this process is running on. */
export function currentPlatform(): Platform {
  return normalizePlatform(process.platform)
}

/**
 * Whether paths on this platform compare case-insensitively. Windows and the
 * macOS default (APFS, case-insensitive) do; Linux does not, where folding
 * case would merge two genuinely different projects into one mine.
 */
export function isCaseInsensitiveFs(platform: Platform): boolean {
  return platform !== 'linux'
}

/**
 * A comparison key for a path, used to decide whether two paths name the same
 * thing (one mine, one rollout).
 *
 * Windows keeps the historical folding — both separators collapse to `\` and
 * the whole key is lowercased — because Windows paths reach this app from
 * sources that disagree about the separator (Codex's registry writes `\`, a
 * rollout's `session_meta.cwd` can carry `/`). POSIX separators are left
 * untouched: `\` is an ordinary filename character there, so rewriting it
 * would make two different files look like one.
 */
export function normalizePathKey(path: string, platform: Platform): string {
  const folded = platform === 'win32' ? path.replace(/\//g, '\\') : path
  return isCaseInsensitiveFs(platform) ? folded.toLowerCase() : folded
}
