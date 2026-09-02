import { describe, expect, it } from 'vitest'
import {
  PROJECT_QUERY_DEFAULT_LIMIT,
  PROJECT_QUERY_MAX_LIMIT,
  buildProjectQuery,
  escapeLikeWildcards
} from './projectQuery'

describe('escapeLikeWildcards', () => {
  it('escapes the percent sign, so searching for a literal one is not a match-all', () => {
    // The classic hole: unescaped, '100%' becomes the pattern '%100%%', which
    // matches every project whose name contains '100' and then anything.
    expect(escapeLikeWildcards('100%')).toBe('100\\%')
  })

  it('escapes the underscore, which LIKE reads as any single character', () => {
    expect(escapeLikeWildcards('a_b')).toBe('a\\_b')
  })

  it('escapes the escape character itself, so a typed backslash is not a dangling escape', () => {
    // A lone trailing escape character is a malformed pattern, not a search
    // for a backslash — the term has to be escaped before the wildcards are.
    expect(escapeLikeWildcards('a\\b')).toBe('a\\\\b')
    expect(escapeLikeWildcards('\\')).toBe('\\\\')
  })

  it('leaves an ordinary term untouched', () => {
    expect(escapeLikeWildcards('cafeteria')).toBe('cafeteria')
  })
})

describe('buildProjectQuery — filtering', () => {
  it('filters nothing when neither a tier nor a term was asked for', () => {
    const { sql, params } = buildProjectQuery({ sortBy: 'addedAt', direction: 'desc' })
    expect(sql).not.toContain('WHERE')
    expect(params).toEqual([PROJECT_QUERY_DEFAULT_LIMIT, 0])
  })

  it('filters on the stored known_tier column, with the tier bound and never interpolated', () => {
    const { sql, params } = buildProjectQuery({
      tier: 'gold',
      sortBy: 'addedAt',
      direction: 'desc'
    })
    expect(sql).toContain('known_tier = ?')
    expect(sql).not.toContain('gold')
    expect(params[0]).toBe('gold')
  })

  it('matches the folded name column as a substring, with the term bound', () => {
    const { sql, params } = buildProjectQuery({
      nameContains: 'Cafetería',
      sortBy: 'addedAt',
      direction: 'desc'
    })
    expect(sql).toContain('name_norm LIKE ?')
    // Folded with the same normalizer the store writes the column with, or the
    // pattern could never match what was stored.
    expect(params[0]).toBe('%cafeteria%')
  })

  it('escapes wildcards in the term before wrapping it, and declares the ESCAPE character', () => {
    const { sql, params } = buildProjectQuery({
      nameContains: '100%',
      sortBy: 'addedAt',
      direction: 'desc'
    })
    expect(sql).toContain("ESCAPE '\\'")
    expect(params[0]).toBe('%100\\%%')
  })

  it('treats a blank term as no search at all, rather than as a pattern', () => {
    for (const nameContains of ['', '   ']) {
      const { sql } = buildProjectQuery({ nameContains, sortBy: 'addedAt', direction: 'desc' })
      expect(sql).not.toContain('LIKE')
    }
  })

  it('trims the term, so a trailing space does not empty the results', () => {
    const { params } = buildProjectQuery({
      nameContains: '  cafe  ',
      sortBy: 'addedAt',
      direction: 'desc'
    })
    expect(params[0]).toBe('%cafe%')
  })

  it('combines a tier and a term, in the order the parameters are bound', () => {
    const { sql, params } = buildProjectQuery({
      tier: 'silver',
      nameContains: 'smelter',
      sortBy: 'addedAt',
      direction: 'desc'
    })
    expect(sql).toContain('known_tier = ?')
    expect(sql).toContain('name_norm LIKE ?')
    expect(params).toEqual(['silver', '%smelter%', PROJECT_QUERY_DEFAULT_LIMIT, 0])
  })
})

describe('buildProjectQuery — ordering', () => {
  it('orders by the added date when that is the key, in both directions', () => {
    expect(buildProjectQuery({ sortBy: 'addedAt', direction: 'desc' }).sql).toContain(
      'ORDER BY added_at DESC, id ASC'
    )
    expect(buildProjectQuery({ sortBy: 'addedAt', direction: 'asc' }).sql).toContain(
      'ORDER BY added_at ASC, id ASC'
    )
  })

  it('orders by the last-opened date when that is the key, in both directions', () => {
    expect(buildProjectQuery({ sortBy: 'lastOpenedAt', direction: 'desc' }).sql).toContain(
      'ORDER BY last_opened_at DESC, id ASC'
    )
    expect(buildProjectQuery({ sortBy: 'lastOpenedAt', direction: 'asc' }).sql).toContain(
      'ORDER BY last_opened_at ASC, id ASC'
    )
  })

  it('never writes a caller-supplied sort key into the statement', () => {
    // Unreachable through the type system and refused at the IPC boundary, but
    // this is the one line in the file that concatenates an identifier rather
    // than binding a parameter, so what it does with a value that got past both
    // is worth stating: it falls back, and never emits what it was handed.
    const hostile = { sortBy: 'added_at; DROP TABLE projects', direction: 'desc' }
    const { sql } = buildProjectQuery(hostile as unknown as Parameters<typeof buildProjectQuery>[0])
    expect(sql).not.toContain('DROP')
    expect(sql).toContain('ORDER BY added_at DESC, id ASC')
  })

  it('always breaks ties on the id, so a page cannot shuffle between reads', () => {
    // Without a total order, two projects added in the same millisecond can
    // swap places between two queries — and paging over an unstable order
    // silently skips and repeats rows.
    for (const sortBy of ['addedAt', 'lastOpenedAt'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(buildProjectQuery({ sortBy, direction }).sql).toContain(', id ASC')
      }
    }
  })
})

describe('buildProjectQuery — paging', () => {
  it('applies a default limit when none was asked for', () => {
    const { sql, params } = buildProjectQuery({ sortBy: 'addedAt', direction: 'desc' })
    expect(sql).toContain('LIMIT ? OFFSET ?')
    expect(params).toEqual([PROJECT_QUERY_DEFAULT_LIMIT, 0])
  })

  it('caps the limit, so one query cannot ask for the whole table', () => {
    const { params } = buildProjectQuery({
      sortBy: 'addedAt',
      direction: 'desc',
      limit: PROJECT_QUERY_MAX_LIMIT + 1_000
    })
    expect(params).toEqual([PROJECT_QUERY_MAX_LIMIT, 0])
  })

  it('never asks for zero or fewer rows, which reads as an empty history', () => {
    for (const limit of [0, -5]) {
      expect(buildProjectQuery({ sortBy: 'addedAt', direction: 'desc', limit }).params).toEqual([
        1, 0
      ])
    }
  })

  it('rounds a fractional limit rather than handing SQLite a float', () => {
    expect(buildProjectQuery({ sortBy: 'addedAt', direction: 'desc', limit: 10.7 }).params).toEqual(
      [11, 0]
    )
  })

  it('falls back to the default for a limit that is not a finite number', () => {
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildProjectQuery({ sortBy: 'addedAt', direction: 'desc', limit }).params).toEqual([
        PROJECT_QUERY_DEFAULT_LIMIT,
        0
      ])
    }
  })

  it('pages with the offset it was given', () => {
    expect(
      buildProjectQuery({ sortBy: 'addedAt', direction: 'desc', limit: 20, offset: 40 }).params
    ).toEqual([20, 40])
  })

  it('floors a negative or unusable offset at the first row', () => {
    for (const offset of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        buildProjectQuery({ sortBy: 'addedAt', direction: 'desc', limit: 20, offset }).params
      ).toEqual([20, 0])
    }
  })
})
