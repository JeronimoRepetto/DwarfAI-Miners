import { describe, expect, it } from 'vitest'
import { aggregateMines } from '../domain/aggregate'
import { defaultProviderSnapshot } from '../domain/types'
import { normalizeProjectName, projectNameForPath } from './projectName'

describe('normalizeProjectName', () => {
  it('folds case and strips accents so a search can match either form', () => {
    // The exact value #92's probe ran against SQLite's LIKE: the raw column
    // matched nothing, the folded one matched.
    expect(normalizeProjectName('Cafetería-Ñandú')).toBe('cafeteria-nandu')
  })

  it('leaves a plain ASCII name alone apart from case', () => {
    expect(normalizeProjectName('DwarfAI-Miners')).toBe('dwarfai-miners')
  })

  it('keeps the folded form matchable as a substring, which is the whole point (#92)', () => {
    // "typing `ontein` finds `container`" — the requirement that rules out
    // token matching. Nothing here queries SQL; this pins the shape the query
    // in #92 will rely on.
    expect(normalizeProjectName('Contáiner')).toContain('ontainer')
  })

  it('folds every diacritic, not only the ones on the first character', () => {
    expect(normalizeProjectName('Ünïcôdé Prôjèçt')).toBe('unicode project')
  })
})

describe('projectNameForPath', () => {
  it('takes the last segment of a Windows path', () => {
    expect(projectNameForPath('C:\\code\\cafeteria')).toBe('cafeteria')
  })

  it('takes the last segment of a POSIX path', () => {
    expect(projectNameForPath('/home/j/code/cafeteria')).toBe('cafeteria')
  })

  it('ignores trailing separators, which a folder picker can return', () => {
    expect(projectNameForPath('C:\\code\\cafeteria\\')).toBe('cafeteria')
    expect(projectNameForPath('/home/j/code/cafeteria/')).toBe('cafeteria')
  })

  it('falls back to the path itself when there is no segment to take', () => {
    expect(projectNameForPath('')).toBe('')
  })

  it('derives the same name aggregateMines gives the same path', () => {
    // The drift guard. aggregateMines keeps its own last-segment derivation
    // private, and a declared project has no snapshot to be named from — so if
    // the two ever disagreed, one project would show two names depending on
    // whether anyone happened to be working in it.
    for (const path of ['C:\\code\\cafeteria', '/home/j/code/Cafetería-Ñandú', 'C:\\code']) {
      const [mine] = aggregateMines(
        [{ ...defaultProviderSnapshot(), cwd: path, updatedAt: 1 }],
        () => 'bronze',
        'win32'
      )
      expect(mine).toBeDefined()
      expect(projectNameForPath(path)).toBe(mine!.name)
    }
  })
})
