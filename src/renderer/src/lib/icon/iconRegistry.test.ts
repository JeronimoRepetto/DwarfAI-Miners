import { describe, expect, it } from 'vitest'
import { ICON_GRIDS, type IconName } from './iconGrids'
import { ICON_PALETTE, createIconRegistry, icons, iconRuns, outlined } from './iconRegistry'

const EMPTY = Array.from({ length: 16 }, () => '.'.repeat(16))

describe('the provisional icon set', () => {
  const names = Object.keys(ICON_GRIDS) as IconName[]

  it('holds the 28 grids of the registry: 27 control icons and the app mark', () => {
    expect(names).toHaveLength(28)
    expect(names).toContain('mark')
  })

  it.each(names)('draws %s on a 16x16 grid in palette keys only', (name) => {
    const grid = ICON_GRIDS[name]
    expect(grid).toHaveLength(16)
    for (const row of grid) {
      expect(row).toHaveLength(16)
      for (const key of row) if (key !== '.') expect(ICON_PALETTE).toHaveProperty(key)
    }
  })

  // The grids are the drawn ones, outline included: outlining them again adds nothing.
  it.each(names)('already carries the outline wherever %s touches transparency', (name) => {
    expect(outlined(ICON_GRIDS[name])).toEqual([...ICON_GRIDS[name]])
  })
})

describe('outlined', () => {
  it('turns a transparent cell beside a fill into outline, up, down, left and right only', () => {
    const fills = [...EMPTY]
    fills[5] = '.....b..........'
    const drawn = outlined(fills)
    expect(drawn[4]).toBe('.....o..........')
    expect(drawn[5]).toBe('....obo.........')
    expect(drawn[6]).toBe('.....o..........')
    expect(drawn[3]).toBe(EMPTY[3])
  })

  it('keeps an outline cell drawn by hand, and outlines nothing next to one', () => {
    const fills = [...EMPTY]
    fills[0] = 'o...............'
    expect(outlined(fills)).toEqual(fills)
  })
})

describe('iconRuns', () => {
  it('makes one rect per horizontal run of one key, skipping transparency', () => {
    const grid = [...EMPTY]
    grid[2] = '..oobbB.........'
    expect(iconRuns(grid)).toEqual([
      { x: 2, y: 2, width: 2, className: 'c-o' },
      { x: 4, y: 2, width: 2, className: 'c-b' },
      { x: 6, y: 2, width: 1, className: 'c-B2' }
    ])
  })

  it('names each key by its palette class', () => {
    expect(ICON_PALETTE).toMatchObject({ o: 'o', B: 'B2', G: 'G2', S: 'S2', R: 'R2', k: 'k' })
  })
})

describe('the icon registry', () => {
  it('draws a placeholder from its grid', () => {
    const drawn = icons.lookup('send')
    expect(drawn.kind).toBe('cells')
    if (drawn.kind === 'cells') expect(drawn.runs).toEqual(iconRuns(ICON_GRIDS.send))
  })

  it('lets a drawn file replace a placeholder under the same name, for every caller', () => {
    const registry = createIconRegistry(ICON_GRIDS)
    registry.register('map', { src: 'map.png' })
    expect(registry.lookup('map')).toEqual({ kind: 'image', src: 'map.png' })
    expect(registry.lookup('mines').kind).toBe('cells')
    // The app's own registry is untouched by another one's registration.
    expect(icons.lookup('map').kind).toBe('cells')
  })

  it('refuses a name it does not hold rather than drawing nothing', () => {
    expect(() => icons.lookup('nope' as IconName)).toThrow(/nope/)
  })
})
