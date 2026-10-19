import { describe, expect, it } from 'vitest'
import { foldForSearch, searchTermOf } from './mineSearch'

describe('the Mines page search fold (US-MINES-001; NFR-PERF-05)', () => {
  it('[US-MINES-001.AC05] a name folds without case or accents, so a differently typed query still finds it', () => {
    expect(foldForSearch('Cafetería')).toBe('cafeteria')
    expect(foldForSearch('ÑANDÚ-Über')).toBe('nandu-uber')
    expect(foldForSearch('container')).toBe('container')
  })

  it('[US-MINES-001.AC05] a search term is trimmed and folded the same way, and an empty one is no filter', () => {
    expect(searchTermOf('  CAFETERÍA ')).toBe('cafeteria')
    expect(searchTermOf('   ')).toBeNull()
    expect(searchTermOf(undefined)).toBeNull()
    // The LIKE wildcards stay characters here; the adapter escapes them (ADR-005 bound SQL).
    expect(searchTermOf('100%_x')).toBe('100%_x')
  })
})
