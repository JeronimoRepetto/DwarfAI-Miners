import { describe, expect, it } from 'vitest'
import {
  BROWSE_PAGE_SIZE,
  defaultBrowseFilters,
  hasMorePages,
  projectQueryFor,
  toggledDirection
} from './browseQuery'

describe('browse filters', () => {
  it('starts on All, an empty search and the newest projects first', () => {
    expect(defaultBrowseFilters()).toEqual({ search: '', tier: null, direction: 'desc' })
  })

  it('flips the date order both ways', () => {
    expect(toggledDirection('desc')).toBe('asc')
    expect(toggledDirection('asc')).toBe('desc')
  })
})

describe('projectQueryFor', () => {
  it('orders by the added date, the one date every project has', () => {
    const query = projectQueryFor(defaultBrowseFilters(), 0)
    expect(query.sortBy).toBe('addedAt')
    expect(query.direction).toBe('desc')
  })

  it('asks for one page at the given offset', () => {
    const query = projectQueryFor(defaultBrowseFilters(), 20)
    expect(query.limit).toBe(BROWSE_PAGE_SIZE)
    expect(query.offset).toBe(20)
  })

  it('pages in tens', () => {
    expect(BROWSE_PAGE_SIZE).toBe(10)
  })

  it('sends no tier at all for the All chip', () => {
    const query = projectQueryFor({ ...defaultBrowseFilters(), tier: null }, 0)
    expect('tier' in query).toBe(false)
  })

  it('sends the chosen tier for every other chip', () => {
    const query = projectQueryFor({ ...defaultBrowseFilters(), tier: 'copper' }, 0)
    expect(query.tier).toBe('copper')
  })

  it('sends no name filter while the search box is empty', () => {
    const query = projectQueryFor({ ...defaultBrowseFilters(), search: '' }, 0)
    expect('nameContains' in query).toBe(false)
  })

  it('sends what was typed, byte for byte', () => {
    // Main folds the term with the same normalizer that wrote the stored
    // column, so trimming, lowercasing or stripping accents here would search
    // for something the user did not type.
    const query = projectQueryFor({ ...defaultBrowseFilters(), search: '  Café ' }, 0)
    expect(query.nameContains).toBe('  Café ')
  })

  it('carries the flipped direction into the query', () => {
    const query = projectQueryFor({ ...defaultBrowseFilters(), direction: 'asc' }, 0)
    expect(query.direction).toBe('asc')
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
