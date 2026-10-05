// Dispatch by the longest root prefix (FM-093; L-09): when the roots of two adapters overlap (a
// Codex rollout folder under a root another adapter also walks), a file belongs to the adapter
// whose root is the longest prefix of its canonical path. Roots and paths are compared in their
// canonical (`realpath`) spelling, on a path-segment boundary, case-insensitively where the
// separator says Windows (a backslash). Pure.

const BACKSLASH = '\\'

/** Whether `root` contains `path` on a segment boundary. */
export function underRoot(path: string, root: string): boolean {
  const windows = path.includes(BACKSLASH) || root.includes(BACKSLASH)
  const p = windows ? path.toLowerCase() : path
  const r = windows ? root.toLowerCase() : root
  if (p === r) return true
  const trimmed = r.endsWith('/') || r.endsWith(BACKSLASH) ? r.slice(0, -1) : r
  return p.startsWith(trimmed + '/') || (windows && p.startsWith(trimmed + BACKSLASH))
}

/** The length of the longest of `roots` that contains `path`, or -1 when none does. */
export function longestRoot(path: string, roots: readonly string[]): number {
  let best = -1
  for (const root of roots) if (underRoot(path, root) && root.length > best) best = root.length
  return best
}

/** Whether `path` belongs to the adapter of `own` roots rather than to any `claimed` root. */
export function dispatchedTo(
  path: string,
  own: readonly string[],
  claimed: readonly string[]
): boolean {
  const mine = longestRoot(path, own)
  return mine >= 0 && mine >= longestRoot(path, claimed)
}
