import { describe, expect, it } from 'vitest'
import { firstEnabled, menuItemClasses, menuKeyTarget, placeFloating, type MenuEntry } from './menu'

const items: MenuEntry[] = [
  { label: 'Fold worktrees', hint: '3' },
  { separator: true },
  { label: 'Stop dwarf…', disabled: true },
  { label: 'Remove mine…', danger: true }
]

describe('menuItemClasses', () => {
  it('is a menu item, marked danger when it is one, in the kit order', () => {
    expect(menuItemClasses({ label: 'Open console' })).toEqual(['dm-menu__item'])
    expect(menuItemClasses({ label: 'Remove mine…', danger: true })).toEqual([
      'dm-menu__item',
      'dm-menu__item--danger'
    ])
  })

  it('adds the look a state forces last, as the UI kit states show it', () => {
    expect(menuItemClasses({ label: 'Stop dwarf…', danger: true, state: 'hover' })).toEqual([
      'dm-menu__item',
      'dm-menu__item--danger',
      'is-hover'
    ])
  })
})

describe('menuKeyTarget', () => {
  it('moves down and up over enabled items only, skipping rules and disabled items', () => {
    expect(menuKeyTarget(items, 0, 'ArrowDown')).toBe(3)
    expect(menuKeyTarget(items, 3, 'ArrowUp')).toBe(0)
  })

  it('wraps at both ends', () => {
    expect(menuKeyTarget(items, 3, 'ArrowDown')).toBe(0)
    expect(menuKeyTarget(items, 0, 'ArrowUp')).toBe(3)
  })

  it('jumps to the first and last enabled items on Home and End', () => {
    expect(menuKeyTarget(items, 3, 'Home')).toBe(0)
    expect(menuKeyTarget(items, 0, 'End')).toBe(3)
  })

  it('answers nothing for a key the menu does not move on', () => {
    expect(menuKeyTarget(items, 0, 'a')).toBeUndefined()
  })

  it('answers nothing in a menu with no enabled item', () => {
    expect(menuKeyTarget([{ label: 'Remove mine…', disabled: true }], 0, 'ArrowDown')).toBe(
      undefined
    )
  })
})

describe('firstEnabled', () => {
  it('is the first item that can be picked, which takes focus when the menu opens', () => {
    expect(
      firstEnabled([{ separator: true }, { label: 'A', disabled: true }, { label: 'B' }])
    ).toBe(2)
    expect(firstEnabled([{ label: 'A', disabled: true }])).toBeUndefined()
  })
})

describe('placeFloating', () => {
  const viewport = { width: 800, height: 600 }
  const anchor = { left: 400, top: 100, right: 432, bottom: 132 }
  const size = { width: 180, height: 90 }

  it('opens below its anchor, 6px away, lined up with its end by default', () => {
    expect(placeFloating(anchor, size, viewport)).toEqual({ left: 252, top: 138 })
  })

  it('lines up with the start or the centre when asked', () => {
    expect(placeFloating(anchor, size, viewport, { align: 'start' }).left).toBe(400)
    expect(placeFloating(anchor, size, viewport, { align: 'center' }).left).toBe(326)
  })

  it('flips above when below would come within 8px of the viewport edge', () => {
    const low = { left: 400, top: 500, right: 432, bottom: 532 }
    expect(placeFloating(low, size, viewport).top).toBe(404)
  })

  it('is clamped 8px inside the viewport either way', () => {
    const corner = { left: 0, top: 100, right: 32, bottom: 132 }
    expect(placeFloating(corner, size, viewport).left).toBe(8)
  })
})
