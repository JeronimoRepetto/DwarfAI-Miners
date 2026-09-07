/**
 * What the Mines panel is filtering and ordering by, and the query that asks
 * main for one page of it (#92).
 *
 * Framework-agnostic on purpose: the panel's whole filtering decision is four
 * values and one translation, and neither needs a component to be true.
 */
import type { MineTier, ProjectQuery, ProjectSortDirection } from '../../types'

/**
 * How many projects one page asks for. The design fixes the batch at ten; main
 * clamps whatever arrives, so this is a request and never a guarantee — which
 * is why hasMorePages() compares against the limit that was actually sent.
 */
export const BROWSE_PAGE_SIZE = 10

/**
 * The panel's filter state.
 *
 * `tier: null` is the All chip: no tier filter at all, which is not the same as
 * a filter that happens to match every tier — an unmeasured project has no
 * stored tier and matches no tier filter, so All is the only chip it appears
 * under.
 */
export interface BrowseFilters {
  search: string
  tier: MineTier | null
  direction: ProjectSortDirection
}

/** All, nothing typed, most recently active first. */
export function defaultBrowseFilters(): BrowseFilters {
  return { search: '', tier: null, direction: 'desc' }
}

export function toggledDirection(direction: ProjectSortDirection): ProjectSortDirection {
  return direction === 'desc' ? 'asc' : 'desc'
}

/**
 * The filters as one page of a project browse.
 *
 * `nameContains` carries what was TYPED, untouched. Main folds the term with
 * the same normalizer that wrote the stored name column, so trimming,
 * lowercasing or stripping accents here would fold it twice and search for
 * something the user did not type. An empty box is no filter rather than an
 * empty one.
 *
 * The order is always by `lastOpenedAt` (#205): the mine someone is working
 * in right now belongs at the top, not buried under whichever project
 * happened to be declared first. `addedAt` stays a valid `ProjectSortKey` on
 * the wire and main still answers it, but the design's date-sort control
 * offers no second key to choose, so this is the only one the panel ever
 * sends. A project nobody has ever opened has no last-activity date at all —
 * main's NULL-last rule (`projectQuery.ts`) is what puts those at the bottom
 * under this default direction rather than scattering them through the list.
 */
export function projectQueryFor(filters: BrowseFilters, offset: number): ProjectQuery {
  const query: ProjectQuery = {
    sortBy: 'lastOpenedAt',
    direction: filters.direction,
    limit: BROWSE_PAGE_SIZE,
    offset
  }
  if (filters.tier !== null) query.tier = filters.tier
  if (filters.search !== '') query.nameContains = filters.search
  return query
}

/**
 * Whether another page is worth asking for.
 *
 * A short page is the end of the list: main fills a page whenever it can, so
 * fewer rows than were asked for means there were no more rows to give.
 */
export function hasMorePages(received: number, limit: number = BROWSE_PAGE_SIZE): boolean {
  return received >= limit
}
