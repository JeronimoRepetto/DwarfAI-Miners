// How a mine name is matched by the Mines page search (US-MINES-001; NFR-PERF-05): ignoring case and
// accents, as a substring. Pure. The folded form is stored beside the name (`mines.name_norm`,
// 09 §4.2, D-13) so the browse search runs on an index (09 §4.11 `mines_name_norm`); the search term
// is folded the same way, so both sides always agree.
//
// Transplanted from `src/main/projects/projectName.ts` (`normalizeProjectName`): SQLite's LIKE and
// NOCASE fold ASCII only, so the fold is done here, once, and stored.

/** NFD-decomposed, diacritics dropped, lowercased: `Cafetería` → `cafeteria`. */
export function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/**
 * The search term as the stored column holds it, or null when there is nothing to search for: a
 * term is trimmed, and one that folds away to nothing is no filter at all.
 */
export function searchTermOf(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const folded = foldForSearch(raw.trim())
  return folded === '' ? null : folded
}
