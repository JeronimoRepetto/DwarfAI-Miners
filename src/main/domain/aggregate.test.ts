import { describe, expect, it } from 'vitest'
import { aggregateMines, mineIdForPath, sumTokensObserved } from './aggregate'
import {
  defaultDwarf,
  defaultMine,
  defaultProviderSnapshot,
  type MineTier,
  type ProviderSnapshot
} from './types'

function snapshot(overrides: Partial<ProviderSnapshot>): ProviderSnapshot {
  return { ...defaultProviderSnapshot(), ...overrides }
}

const tierOf = (): MineTier => 'silver'

describe('aggregateMines', () => {
  it('groups snapshots by cwd into one mine per project', () => {
    const mines = aggregateMines(
      [
        snapshot({
          provider: 'claude',
          sessionId: 's1',
          cwd: 'C:\\Users\\j\\Desktop\\Sample-Project',
          status: 'busy',
          dwarfs: [{ ...defaultDwarf(), id: 'claude:s1', sessionId: 's1' }],
          updatedAt: 100
        }),
        snapshot({
          provider: 'codex',
          sessionId: 's2',
          cwd: 'C:\\Users\\j\\Desktop\\Sample-Project',
          status: 'idle',
          updatedAt: 200
        }),
        snapshot({
          provider: 'claude',
          sessionId: 's3',
          cwd: 'C:\\Users\\j\\Desktop\\Other',
          status: 'idle',
          updatedAt: 50
        })
      ],
      tierOf
    )

    expect(mines).toHaveLength(2)
    const sampleProject = mines.find((m) => m.name === 'Sample-Project')!
    expect(sampleProject.path).toBe('C:\\Users\\j\\Desktop\\Sample-Project')
    expect(sampleProject.dwarfs.map((d) => d.id)).toEqual(['claude:s1'])
    expect(sampleProject.updatedAt).toBe(200)
    expect(sampleProject.tier).toBe('silver')
    const other = mines.find((m) => m.name === 'Other')!
    expect(other.dwarfs).toEqual([])
  })

  it('groups case-insensitively but keeps the first-seen path for display', () => {
    const mines = aggregateMines(
      [
        snapshot({ sessionId: 's1', cwd: 'C:\\Users\\j\\Desktop\\Sample-Project' }),
        snapshot({ sessionId: 's2', cwd: 'c:\\users\\j\\desktop\\sample-project' })
      ],
      tierOf,
      'win32'
    )
    expect(mines).toHaveLength(1)
    expect(mines[0]!.path).toBe('C:\\Users\\j\\Desktop\\Sample-Project')
  })

  it('groups the two Windows separators as one project', () => {
    const mines = aggregateMines(
      [
        snapshot({ sessionId: 's1', cwd: 'C:\\X\\Proj' }),
        snapshot({ sessionId: 's2', cwd: 'C:/X/Proj' })
      ],
      tierOf,
      'win32'
    )
    expect(mines).toHaveLength(1)
  })

  it('keeps two Linux projects that differ only in case apart', () => {
    // /home/j/Proj and /home/j/proj really are two different directories
    // there; folding them would put two crews in the wrong mine.
    const mines = aggregateMines(
      [
        snapshot({ sessionId: 's1', cwd: '/home/j/Proj' }),
        snapshot({ sessionId: 's2', cwd: '/home/j/proj' })
      ],
      tierOf,
      'linux'
    )
    expect(mines).toHaveLength(2)
  })

  it('still groups two macOS spellings of one project', () => {
    const mines = aggregateMines(
      [
        snapshot({ sessionId: 's1', cwd: '/Users/j/Proj' }),
        snapshot({ sessionId: 's2', cwd: '/users/j/proj' })
      ],
      tierOf,
      'darwin'
    )
    expect(mines).toHaveLength(1)
    expect(mines[0]!.path).toBe('/Users/j/Proj')
  })

  it('produces a stable id derived from the normalized path', () => {
    const [a] = aggregateMines([snapshot({ sessionId: 's1', cwd: 'C:\\X\\Proj' })], tierOf, 'win32')
    const [b] = aggregateMines([snapshot({ sessionId: 's9', cwd: 'c:\\x\\proj' })], tierOf, 'win32')
    expect(a!.id).toBe(b!.id)
    expect(a!.id).not.toBe('')
  })

  it('sorts mines by most recent activity first', () => {
    const mines = aggregateMines(
      [
        snapshot({ sessionId: 's1', cwd: 'C:\\A', updatedAt: 10 }),
        snapshot({ sessionId: 's2', cwd: 'C:\\B', updatedAt: 30 }),
        snapshot({ sessionId: 's3', cwd: 'C:\\C', updatedAt: 20 })
      ],
      tierOf
    )
    expect(mines.map((m) => m.path)).toEqual(['C:\\B', 'C:\\C', 'C:\\A'])
  })

  it('uses the last path segment as the mine name, handling trailing slashes', () => {
    const mines = aggregateMines(
      [snapshot({ sessionId: 's1', cwd: 'C:\\Deep\\Nested\\Proj\\' })],
      tierOf
    )
    expect(mines[0]!.name).toBe('Proj')
  })

  it('asks the tier callback once per mine with the display path', () => {
    const asked: string[] = []
    aggregateMines(
      [
        snapshot({ sessionId: 's1', cwd: 'C:\\X\\Proj' }),
        snapshot({ sessionId: 's2', cwd: 'c:\\x\\proj' })
      ],
      (path) => {
        asked.push(path)
        return 'gold'
      },
      'win32'
    )
    expect(asked).toEqual(['C:\\X\\Proj'])
  })

  it('returns [] for no snapshots', () => {
    expect(aggregateMines([], tierOf)).toEqual([])
  })

  it('sums every dwarfs tokensObserved into the mine total', () => {
    const mines = aggregateMines(
      [
        snapshot({
          sessionId: 's1',
          cwd: 'C:\\X\\Proj',
          dwarfs: [
            { ...defaultDwarf(), id: 'a', tokensObserved: 1_000 },
            { ...defaultDwarf(), id: 'b', tokensObserved: 250 }
          ]
        }),
        snapshot({
          sessionId: 's2',
          cwd: 'C:\\X\\Proj',
          dwarfs: [{ ...defaultDwarf(), id: 'c', tokensObserved: 500 }]
        })
      ],
      tierOf
    )
    expect(mines[0]!.tokensObserved).toBe(1_750)
  })

  it('treats a dwarf with no tokensObserved as contributing zero', () => {
    const mines = aggregateMines(
      [
        snapshot({
          sessionId: 's1',
          cwd: 'C:\\X\\Proj',
          dwarfs: [{ ...defaultDwarf(), id: 'a' }]
        })
      ],
      tierOf
    )
    expect(mines[0]!.tokensObserved).toBe(0)
  })

  it('defaults tokensObserved to 0 for a mine with no dwarfs', () => {
    const [mine] = aggregateMines([snapshot({ sessionId: 's1', cwd: 'C:\\X' })], tierOf)
    expect(mine!.tokensObserved).toBe(0)
  })
})

describe('mineIdForPath', () => {
  it('produces exactly the id aggregateMines gives the same project', () => {
    // The coal backfill credits projects it found on disk, with no snapshot to
    // group. If its ids drifted from these, historical coal would land on a
    // mine that never appears next to the live one.
    const [mine] = aggregateMines(
      [snapshot({ sessionId: 's1', cwd: 'C:\\X\\Proj' })],
      tierOf,
      'win32'
    )
    expect(mineIdForPath('C:\\X\\Proj', 'win32')).toBe(mine!.id)
  })

  it('folds the spellings of one project onto one id', () => {
    expect(mineIdForPath('c:/x/proj/', 'win32')).toBe(mineIdForPath('C:\\X\\Proj', 'win32'))
  })

  it('keeps two Linux projects that differ only in case apart', () => {
    expect(mineIdForPath('/home/j/Proj', 'linux')).not.toBe(mineIdForPath('/home/j/proj', 'linux'))
  })
})

describe('sumTokensObserved', () => {
  it('sums tokensObserved across every mine', () => {
    expect(
      sumTokensObserved([
        { ...defaultMine(), tokensObserved: 100 },
        { ...defaultMine(), tokensObserved: 250 }
      ])
    ).toBe(350)
  })

  it('returns 0 for no mines', () => {
    expect(sumTokensObserved([])).toBe(0)
  })
})
