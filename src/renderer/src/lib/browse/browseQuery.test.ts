import { describe, expect, it } from 'vitest'
import {
  BROWSE_PAGE_SIZE,
  defaultBrowseFilters,
  hasMorePages,
  projectQueryFor
} from './browseQuery'

/*
 * AMENDED for #635 (PR2): the redesigned Mines page reads every project once and filters and
 * orders the cards itself (screens/browse.md: "search, tier filter and sort only hide and reorder
 * existing nodes"), so the query carries no filter and the date order is no longer the user's.
 * Removed with that change, each guarantee now held by lib/browse/minesList.test.ts: "flips the
 * date order both ways" and "carries the flipped direction into the query" (the sort cycles tier,
 * name, needs you first: "cycles tier, then name, then needs you first, and back"); "sends the
 * chosen tier for every other chip" and "sends what was typed, byte for byte" (filterCards: "keeps
 * the mines of the chosen tier…" and "keeps the names holding what was typed, folded like the
 * store folds them").
 */
describe('browse filters', () => {
  // AMENDED for #635: the order is the page's sort, tier richest first by default (was: the most
  // recently active projects first, a date direction).
  it('starts on All, an empty search and the richest tier first', () => {
    expect(defaultBrowseFilters()).toEqual({ search: '', tier: null, sort: 'tier' })
  })
})

describe('projectQueryFor', () => {
  it('orders by last activity, most recently worked mine first (#205)', () => {
    const query = projectQueryFor(0)
    expect(query.sortBy).toBe('lastOpenedAt')
    expect(query.direction).toBe('desc')
  })

  it('asks for one page at the given offset', () => {
    const query = projectQueryFor(20)
    expect(query.limit).toBe(BROWSE_PAGE_SIZE)
    expect(query.offset).toBe(20)
  })

  // AMENDED for #635: the page reads every project, so a page is the most main answers at once
  // (PROJECT_QUERY_MAX_LIMIT in main/projects/projectQuery.ts), no longer the design's ten.
  it('pages in the most rows main answers at once', () => {
    expect(BROWSE_PAGE_SIZE).toBe(500)
  })

  // AMENDED for #635: "sends no tier at all for the All chip" and "sends no name filter while the
  // search box is empty" are one fact now: the query carries no filter, whatever is on screen.
  it('carries no filter: the page filters what it shows', () => {
    const query = projectQueryFor(0)
    expect('tier' in query).toBe(false)
    expect('nameContains' in query).toBe(false)
  })
})

describe('hasMorePages', () => {
  it('keeps paging while a page comes back full', () => {
    expect(hasMorePages(BROWSE_PAGE_SIZE)).toBe(true)
  })

  it('stops at the first short page — there is nothing behind it', () => {
    expect(hasMorePages(BROWSE_PAGE_SIZE - 1)).toBe(false)
  })

  it('stops on an empty page', () => {
    expect(hasMorePages(0)).toBe(false)
  })

  it('measures against the limit that was actually asked for', () => {
    expect(hasMorePages(3, 3)).toBe(true)
    expect(hasMorePages(2, 3)).toBe(false)
  })
})
