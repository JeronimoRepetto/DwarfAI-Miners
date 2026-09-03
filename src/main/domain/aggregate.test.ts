import { describe, expect, it } from 'vitest'
import {
  aggregateMines,
  collapseDuplicateMines,
  mergeDeclaredMines,
  mineIdForPath,
  stampMapSites,
  sumTokensObserved
} from './aggregate'
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

describe('mergeDeclaredMines', () => {
  it('puts a declared project with no live session on the board with no crew', () => {
    const mines = mergeDeclaredMines([], [{ path: 'C:\\X\\Adopted' }], tierOf, 'win32')

    expect(mines).toHaveLength(1)
    expect(mines[0]!.name).toBe('Adopted')
    expect(mines[0]!.dwarfs).toEqual([])
    expect(mines[0]!.tokensObserved).toBe(0)
    expect(mines[0]!.declared).toBe(true)
  })

  it('gives a declared mine the id the ledger already credits that path under', () => {
    // The whole reason not to invent a second id scheme: whatever the vault
    // accrued for this project attaches to the mine the user just added.
    const [mine] = mergeDeclaredMines([], [{ path: 'c:/x/adopted/' }], tierOf, 'win32')
    expect(mine!.id).toBe(mineIdForPath('C:\\X\\Adopted', 'win32'))
  })

  it('merges a declared project that is also being worked into one mine', () => {
    const live = aggregateMines(
      [snapshot({ sessionId: 's1', cwd: 'C:\\X\\Adopted', updatedAt: 40 })],
      tierOf,
      'win32'
    )
    const mines = mergeDeclaredMines(live, [{ path: 'c:\\x\\adopted' }], tierOf, 'win32')

    expect(mines).toHaveLength(1)
    expect(mines[0]!.declared).toBe(true)
    // The live reading wins on everything else: the crew, the display spelling
    // and the activity clock all come from the session that is actually there.
    expect(mines[0]!.path).toBe('C:\\X\\Adopted')
    expect(mines[0]!.updatedAt).toBe(40)
  })

  it('leaves a discovered mine unmarked so the panel can tell the two apart', () => {
    const live = aggregateMines(
      [snapshot({ sessionId: 's1', cwd: 'C:\\X\\Other' })],
      tierOf,
      'win32'
    )
    const mines = mergeDeclaredMines(live, [{ path: 'C:\\X\\Adopted' }], tierOf, 'win32')

    expect(mines.find((mine) => mine.name === 'Other')!.declared).toBeUndefined()
  })

  it('draws a declared mine at its MEASURED tier when the store holds one', () => {
    const [mine] = mergeDeclaredMines(
      [],
      [{ path: 'C:\\X\\Adopted', knownTier: 'gold' }],
      tierOf,
      'win32'
    )
    expect(mine!.tier).toBe('gold')
  })

  it('falls back to the provisional tier for a project nobody has walked yet', () => {
    // tierOf's placeholder is exactly what a never-measured mine is DRAWN as
    // (#41); it seals nothing, and the ledger is asked separately.
    const [mine] = mergeDeclaredMines([], [{ path: 'C:\\X\\Adopted' }], tierOf, 'win32')
    expect(mine!.tier).toBe('silver')
  })

  it('never mutates the mines aggregation handed it', () => {
    const live = aggregateMines(
      [snapshot({ sessionId: 's1', cwd: 'C:\\X\\Adopted' })],
      tierOf,
      'win32'
    )
    mergeDeclaredMines(live, [{ path: 'C:\\X\\Adopted' }], tierOf, 'win32')
    expect(live[0]!.declared).toBeUndefined()
  })

  it('returns the same list untouched when nothing is declared', () => {
    const live = aggregateMines(
      [snapshot({ sessionId: 's1', cwd: 'C:\\X\\Proj' })],
      tierOf,
      'win32'
    )
    expect(mergeDeclaredMines(live, [], tierOf, 'win32')).toBe(live)
  })

  it('sorts a crewless declared mine behind everything with recent activity', () => {
    const live = aggregateMines(
      [snapshot({ sessionId: 's1', cwd: 'C:\\X\\Busy', updatedAt: 10 })],
      tierOf,
      'win32'
    )
    const mines = mergeDeclaredMines(live, [{ path: 'C:\\X\\Adopted' }], tierOf, 'win32')
    expect(mines.map((mine) => mine.name)).toEqual(['Busy', 'Adopted'])
  })

  it('keeps two Linux projects that differ only in case apart', () => {
    const live = aggregateMines(
      [snapshot({ sessionId: 's1', cwd: '/home/j/Proj' })],
      tierOf,
      'linux'
    )
    const mines = mergeDeclaredMines(live, [{ path: '/home/j/proj' }], tierOf, 'linux')
    expect(mines).toHaveLength(2)
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

describe('stampMapSites', () => {
  it('stamps each mine with the location the store remembers for it', () => {
    const mines = [
      { ...defaultMine(), id: 'mine:a' },
      { ...defaultMine(), id: 'mine:b' }
    ]
    const stamped = stampMapSites(
      mines,
      new Map([
        ['mine:a', 12],
        ['mine:b', 41]
      ])
    )
    expect(stamped.map((mine) => mine.mapSite)).toEqual([12, 41])
  })

  /*
    Absent, never a zero or a placeholder. A mine nobody has placed — a
    simulated one, or a project whose first write has not landed yet — is drawn
    by the panel's own deterministic fallback, and the wire says so by saying
    nothing at all. The same discipline knownTier uses (#41).
  */
  it('leaves a mine the store has never placed unstamped', () => {
    const stamped = stampMapSites([{ ...defaultMine(), id: 'mine:a' }], new Map())
    expect(stamped[0]!.mapSite).toBeUndefined()
    expect('mapSite' in stamped[0]!).toBe(false)
  })

  it('never mutates the mines it was given', () => {
    const mine = { ...defaultMine(), id: 'mine:a' }
    stampMapSites([mine], new Map([['mine:a', 3]]))
    expect(mine.mapSite).toBeUndefined()
  })

  it('is the same list when nothing is known about any mine', () => {
    const mines = [{ ...defaultMine(), id: 'mine:a' }]
    expect(stampMapSites(mines, new Map())).toBe(mines)
  })

  it('joins on the mine id, which is the id the store keys by', () => {
    // mineIdForPath either side: a second id scheme here would silently drop
    // every placement, and the map would look exactly as it does with none.
    const path = 'C:\code\forge'
    const mine = { ...defaultMine(), id: mineIdForPath(path, 'win32'), path }
    const stamped = stampMapSites([mine], new Map([[mineIdForPath(path, 'win32'), 55]]))
    expect(stamped[0]!.mapSite).toBe(55)
  })
})

/*
 * ONE MINE PER PROJECT, whatever the board was assembled from (#156).
 *
 * The acceptance run photographed four markers over three projects. The board
 * is assembled from four sources — the provider snapshots, the projects the
 * user declared, the placement stamp and the lifecycle tracker's memory of a
 * session that has just ended — and every one of them derives its id through
 * `mineIdForPath`. So two mines that reach the same board under one id ARE one
 * project, and drawing both is never right: the map keys its markers by mine
 * id, and the panel places an unplaced mine itself, so the double shows up as
 * the same project standing in two places.
 *
 * Enforced once, at the end of the assembly, rather than audited across four
 * joins forever. Collapsing is a MERGE and never a pick: dropping the second
 * mine would take a live agent off the board, which is a worse failure than the
 * double it fixes.
 */
describe('collapseDuplicateMines', () => {
  function mineOf(overrides: Partial<ReturnType<typeof defaultMine>>) {
    return { ...defaultMine(), ...overrides }
  }

  it('leaves a board with nothing to collapse exactly as it is', () => {
    const mines = [mineOf({ id: 'mine:a' }), mineOf({ id: 'mine:b' })]
    expect(collapseDuplicateMines(mines)).toBe(mines)
  })

  it('publishes one mine per id', () => {
    const mines = [mineOf({ id: 'mine:a' }), mineOf({ id: 'mine:a' }), mineOf({ id: 'mine:b' })]
    expect(collapseDuplicateMines(mines).map((mine) => mine.id)).toEqual(['mine:a', 'mine:b'])
  })

  it('keeps every dwarf both of them carried', () => {
    const collapsed = collapseDuplicateMines([
      mineOf({ id: 'mine:a', dwarfs: [{ ...defaultDwarf(), id: 'claude:1' }] }),
      mineOf({ id: 'mine:a', dwarfs: [{ ...defaultDwarf(), id: 'codex:2' }] })
    ])
    expect(collapsed[0]!.dwarfs.map((dwarf) => dwarf.id)).toEqual(['claude:1', 'codex:2'])
  })

  it('never lists one dwarf twice, however many mines carried it', () => {
    // The lifecycle tracker rebuilds a vanished mine from what it remembers, so
    // the same departing dwarf can reach the board from two directions.
    const leaving = { ...defaultDwarf(), id: 'claude:1', status: 'leaving' as const }
    const collapsed = collapseDuplicateMines([
      mineOf({ id: 'mine:a', dwarfs: [leaving] }),
      mineOf({ id: 'mine:a', dwarfs: [leaving] })
    ])
    expect(collapsed[0]!.dwarfs).toHaveLength(1)
  })

  it('adds up what each of them observed, because the tokens are per dwarf', () => {
    const collapsed = collapseDuplicateMines([
      mineOf({ id: 'mine:a', tokensObserved: 30 }),
      mineOf({ id: 'mine:a', tokensObserved: 12 })
    ])
    expect(collapsed[0]!.tokensObserved).toBe(42)
  })

  it('keeps the most recent activity, which is what the board sorts by', () => {
    const collapsed = collapseDuplicateMines([
      mineOf({ id: 'mine:a', updatedAt: 10 }),
      mineOf({ id: 'mine:a', updatedAt: 90 })
    ])
    expect(collapsed[0]!.updatedAt).toBe(90)
  })

  it('keeps a location and a declaration either of them carried', () => {
    // The two facts a duplicate is most likely to be missing: the placement
    // stamp joins by id, and the declaration merge only marks the mine it found.
    const collapsed = collapseDuplicateMines([
      mineOf({ id: 'mine:a', mapSite: 71 }),
      mineOf({ id: 'mine:a', declared: true })
    ])
    expect(collapsed[0]!.mapSite).toBe(71)
    expect(collapsed[0]!.declared).toBe(true)
  })

  it('never mutates the board it was given', () => {
    const first = mineOf({ id: 'mine:a', dwarfs: [{ ...defaultDwarf(), id: 'claude:1' }] })
    collapseDuplicateMines([first, mineOf({ id: 'mine:a' })])
    expect(first.dwarfs).toHaveLength(1)
  })
})

/**
 * The nameless mine of the third acceptance run (#165).
 *
 * A bronze mine with no name at all reached the panel, and it was not in the
 * projects store — every stored row carries a name. It was board-side: a live
 * session whose cwd is the filesystem root. Trimming the trailing separator off
 * `/` leaves the empty string, which has no last segment either, so both the
 * path and the name came out empty and the card drew nothing where a project
 * belongs.
 */
describe('a mine whose cwd is a root', () => {
  it('names a POSIX-root session by its path rather than by nothing', () => {
    const [mine] = aggregateMines([snapshot({ sessionId: 's1', cwd: '/' })], tierOf, 'linux')
    expect(mine!.name).toBe('/')
    expect(mine!.path).toBe('/')
  })

  it('names a Windows drive root by the drive', () => {
    const [mine] = aggregateMines([snapshot({ sessionId: 's1', cwd: 'C:\\' })], tierOf, 'win32')
    expect(mine!.name).toBe('C:')
    expect(mine!.path).toBe('C:')
  })

  it('never hands the board an empty name for a cwd that is only separators', () => {
    for (const cwd of ['/', '//', '\\', '\\\\']) {
      const [mine] = aggregateMines([snapshot({ sessionId: 's1', cwd })], tierOf, 'linux')
      expect(mine!.name).not.toBe('')
      expect(mine!.path).not.toBe('')
    }
  })
})
