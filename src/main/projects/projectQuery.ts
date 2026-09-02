import type { SqliteParam } from '../adapters/sqliteWritable'
import type { ProjectQuery } from '../domain/types'
import { normalizeProjectName } from './projectName'

/**
 * How a project browse (#92) becomes SQL.
 *
 * The filtering, the ordering and the paging are all expressed as a WHERE /
 * ORDER BY / LIMIT tail rather than done in JavaScript over every row, because
 * that is the reason the projects store is a database at all: the list has no
 * bound on its length, and the three indexes the schema already carries
 * (`projects_name_norm`, `projects_added_at`, `projects_last_opened_at`) are
 * the three orders this file asks for. Reading the table and filtering it in
 * memory would use none of them.
 *
 * It is a pure function of the query and returns a bound statement, so every
 * rule below is assertable without a database — and, more importantly, so no
 * caller can be tempted to interpolate a user's search term into SQL. Every
 * user-supplied value leaves here as a parameter.
 */

/**
 * The default page size.
 *
 * A browse surface shows a scrollable list, not a table dump: 100 rows is more
 * than the panel can display at its 276 px minimum width and cheap to read, so
 * a caller that names no page gets a page rather than the whole history.
 */
export const PROJECT_QUERY_DEFAULT_LIMIT = 100

/**
 * The most rows one query can ever return.
 *
 * node:sqlite is synchronous and every statement in the projects store runs on
 * the main thread, so an unbounded query is a frame the panel does not draw.
 * The cap is enforced here rather than at the IPC boundary so it holds for
 * every caller, including main's own.
 */
export const PROJECT_QUERY_MAX_LIMIT = 500

/**
 * The character that turns off LIKE's wildcards.
 *
 * A backslash is conventional and cannot appear in a project NAME — the name is
 * a last path segment, so a separator is exactly what it never contains — but
 * it can certainly be TYPED into a search box, which is why it is escaped along
 * with the wildcards below.
 */
const LIKE_ESCAPE_CHAR = '\\'

/**
 * Neutralize LIKE's two wildcards in a term the user typed.
 *
 * Without this, searching for `100%` yields the pattern `%100%%` — which
 * matches any name containing `100` followed by anything, so a search for a
 * literal name returns most of the table. `_` is the quieter half of the same
 * bug: it matches any single character.
 *
 * All three characters are replaced in ONE pass on purpose. Escaping them in
 * sequence would re-escape the backslashes the earlier steps just added, and
 * escaping the wildcards before the escape character would leave a typed
 * backslash as a dangling escape — a malformed pattern rather than a search.
 */
export function escapeLikeWildcards(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `${LIKE_ESCAPE_CHAR}${character}`)
}

/** Which stored column each sort key names. The keys are wire names; these are schema names. */
const SORT_COLUMNS = {
  addedAt: 'added_at',
  lastOpenedAt: 'last_opened_at'
} as const

/** A bound statement tail: everything after `FROM projects`, plus its parameters in order. */
export interface ProjectQuerySql {
  sql: string
  params: SqliteParam[]
}

/**
 * Build the WHERE / ORDER BY / LIMIT tail for one project browse.
 *
 * Ordering is always a TOTAL order — the chosen date and then the id — because
 * paging over anything less is silently wrong: two projects sharing a
 * millisecond can swap places between two queries, and the row that swapped
 * out of page one is skipped rather than shown on page two.
 *
 * `last_opened_at` is NULL for a project the user declared and no agent has
 * been seen in, and SQLite sorts NULL below every number. That lands the
 * never-opened projects last under 'desc' (most recently worked first, then the
 * ones never worked) and first under 'asc', which is the right reading of both
 * directions and is pinned by a test rather than forced with NULLS LAST.
 */
export function buildProjectQuery(query: ProjectQuery): ProjectQuerySql {
  const conditions: string[] = []
  const params: SqliteParam[] = []

  if (query.tier !== undefined) {
    // The MEASURED tier only. A row whose known_tier is NULL matches no tier,
    // because `NULL = 'bronze'` is NULL and never true — which is the intended
    // answer, not an accident of SQL: an unwalked project has no tier to filter
    // on, and the provisional bronze that draws its mound was never stored (#41).
    conditions.push('known_tier = ?')
    params.push(query.tier)
  }

  const term = foldSearchTerm(query.nameContains)
  if (term !== null) {
    // The folded column, matched with the term folded the same way — the whole
    // reason name_norm is written at insert time. Substring, not token: the
    // requirement is "contains the word the user typed", so 'ontein' has to
    // find 'container', which is what ruled FTS5 out (#92).
    conditions.push(`name_norm LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`)
    params.push(`%${escapeLikeWildcards(term)}%`)
  }

  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`
  // The sort key and the direction are the only things here that become SQL
  // TEXT rather than a bound parameter, so both are resolved through a closed
  // table and a comparison instead of being written in. The IPC boundary
  // already refuses a key it does not know (src/main/index.ts), and the type
  // says there are two — but this is the one line where a value that got past
  // both would be concatenated into a statement, so it defaults rather than
  // emitting a column name it was handed.
  const column = SORT_COLUMNS[query.sortBy] ?? SORT_COLUMNS.addedAt
  const direction = query.direction === 'asc' ? 'ASC' : 'DESC'

  params.push(clampLimit(query.limit), clampOffset(query.offset))
  return {
    sql: `${where} ORDER BY ${column} ${direction}, id ASC LIMIT ? OFFSET ?`,
    params
  }
}

/**
 * The term as the stored column holds it, or null when there is nothing to
 * search for.
 *
 * Trimmed because a trailing space is never what a search meant: the pattern
 * `%cafe %` matches nothing a user typing `cafe ` wanted, so an accidental
 * keystroke would empty the list. A term that folds away to nothing — blank, or
 * only characters the fold drops — is no filter at all rather than a pattern
 * that happens to match everything.
 */
function foldSearchTerm(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const folded = normalizeProjectName(raw.trim())
  return folded === '' ? null : folded
}

/**
 * A page size that is always a whole number of rows between one and the cap.
 *
 * Zero and negatives floor at one rather than returning nothing, because an
 * empty page is indistinguishable from an empty history to whoever is reading
 * the panel. A limit that is not a finite number is a caller that did not
 * really name one, so it gets the default.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return PROJECT_QUERY_DEFAULT_LIMIT
  return Math.min(Math.max(Math.round(limit), 1), PROJECT_QUERY_MAX_LIMIT)
}

/** Where the page starts. Anything unusable starts at the first row. */
function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0
  return Math.max(Math.round(offset), 0)
}
