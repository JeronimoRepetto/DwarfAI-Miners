/**
 * How a project is named, and how that name is folded for searching (#92).
 *
 * Both derivations live here because both write paths of the projects store
 * need them and a search is only ever as good as what was written: the folded
 * form is a stored column, not a query-time transformation, so a project
 * inserted with the wrong fold is unfindable no matter how the query is built.
 */

/**
 * The display name of a project: the last segment of its path.
 *
 * Deliberately derived rather than stored anywhere else, so renaming the folder
 * on disk cannot leave a stale label behind (#85). It mirrors the private
 * lastSegment() in domain/aggregate.ts, which names a mine from a live
 * session's cwd; a declared project has no session to be named from. The two
 * are pinned equal by a test, because a drift would show one project under two
 * different names depending on whether anyone happened to be working in it.
 */
export function projectNameForPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? trimmed
}

/**
 * The searchable form of a name: NFD-decomposed, diacritics dropped, lowercased.
 *
 * SQLite's LIKE and its NOCASE collation fold ASCII only — neither matches
 * 'Ñ', 'É' or 'Ü' against their bare letters, and full Unicode collation needs
 * an ICU build this project does not have. Folding here and storing the result
 * is what makes `LIKE '%cafeteria%'` find `Cafetería`, verified against this
 * app's own runtime in #92. It preserves SUBSTRING matching, which is the
 * stated requirement — 'ontein' has to find 'container' — and is why FTS5, which
 * matches whole tokens and prefixes, was not the answer here.
 */
export function normalizeProjectName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}
