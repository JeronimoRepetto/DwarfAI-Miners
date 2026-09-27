/**
 * What the Mines page is filtering and ordering by, and the query that reads one page of every
 * project main remembers (#92).
 *
 * AMENDED for #635 (PR2): the redesigned page reads every project once and filters and orders the
 * cards itself (screens/browse.md: "search, tier filter and sort only hide and reorder existing
 * nodes"; lib/browse/minesList.ts), so the query carries no filter and the order is the page's.
 * Framework-agnostic on purpose: the whole decision is three values and one translation.
 */
import type { MineTier, ProjectQuery } from '../../types'
import type { MineSort } from './minesList'

/**
 * How many projects one page asks for: the most main answers at once
 * (PROJECT_QUERY_MAX_LIMIT in main/projects/projectQuery.ts), since the page reads them all. Main
 * clamps whatever arrives, so this is a request and never a guarantee — which is why
 * hasMorePages() compares against the limit that was actually sent.
 */
export const BROWSE_PAGE_SIZE = 500

/**
 * The page's filter state.
 *
 * `tier: null` is the All chip: no tier filter at all, which is not the same as a filter that
 * happens to match every tier — an unmeasured project has no measured tier and matches no tier
 * chip, so All is the only chip it appears under.
 */
export interface BrowseFilters {
  search: string
  tier: MineTier | null
  sort: MineSort
}

/** All, nothing typed, the richest tier first. */
export function defaultBrowseFilters(): BrowseFilters {
  return { search: '', tier: null, sort: 'tier' }
}

/**
 * One page of every project, most recently active first (#205): the order the reads arrive in,
 * which the page then sorts its own way. A project nobody has ever opened has no last-activity
 * date, and main's NULL-last rule puts those at the end.
 */
export function projectQueryFor(offset: number): ProjectQuery {
  return { sortBy: 'lastOpenedAt', direction: 'desc', limit: BROWSE_PAGE_SIZE, offset }
}

/**
 * Whether another page is worth asking for.
 *
 * A short page is the end of the list: main fills a page whenever it can, so fewer rows than were
 * asked for means there were no more rows to give.
 */
export function hasMorePages(received: number, limit: number = BROWSE_PAGE_SIZE): boolean {
  return received >= limit
}
