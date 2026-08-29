import { describe, expect, it } from 'vitest'
import { aggregateMines } from './aggregate'
import {
  defaultDwarf,
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
          cwd: 'C:\\Users\\jeron\\Desktop\\AI-Tools',
          status: 'busy',
          dwarfs: [{ ...defaultDwarf(), id: 'claude:s1', sessionId: 's1' }],
          updatedAt: 100
        }),
        snapshot({
          provider: 'codex',
          sessionId: 's2',
          cwd: 'C:\\Users\\jeron\\Desktop\\AI-Tools',
          status: 'idle',
          updatedAt: 200
        }),
        snapshot({
          provider: 'claude',
          sessionId: 's3',
          cwd: 'C:\\Users\\jeron\\Desktop\\Other',
          status: 'idle',
          updatedAt: 50
        })
      ],
      tierOf
    )

    expect(mines).toHaveLength(2)
    const aiTools = mines.find((m) => m.name === 'AI-Tools')!
    expect(aiTools.path).toBe('C:\\Users\\jeron\\Desktop\\AI-Tools')
    expect(aiTools.dwarfs.map((d) => d.id)).toEqual(['claude:s1'])
    expect(aiTools.updatedAt).toBe(200)
    expect(aiTools.tier).toBe('silver')
    const other = mines.find((m) => m.name === 'Other')!
    expect(other.dwarfs).toEqual([])
  })

  it('groups case-insensitively but keeps the first-seen path for display', () => {
    const mines = aggregateMines(
      [
        snapshot({ sessionId: 's1', cwd: 'C:\\Users\\jeron\\Desktop\\AI-Tools' }),
        snapshot({ sessionId: 's2', cwd: 'c:\\users\\jeron\\desktop\\ai-tools' })
      ],
      tierOf,
      'win32'
    )
    expect(mines).toHaveLength(1)
    expect(mines[0]!.path).toBe('C:\\Users\\jeron\\Desktop\\AI-Tools')
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
})
