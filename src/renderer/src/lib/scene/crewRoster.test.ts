import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import {
  ROSTER_EMPTY,
  ROSTER_MAX,
  rosterMenuItems,
  rosterMoreLabel,
  rosterSplit
} from './crewRoster'

const crew = (count: number) =>
  Array.from({ length: count }, (_, i) => defaultDwarf({ id: 'd' + i, name: 'dwarf-' + i }))

describe('rosterSplit', () => {
  // Five fit (screens/mine.md, W3·4): up to five, the row shows every one and no +N.
  it('shows every dwarf, up to five, with nothing left over', () => {
    expect(ROSTER_MAX).toBe(5)
    for (const count of [0, 1, 4, 5]) {
      const { shown, rest } = rosterSplit(crew(count))
      expect(shown).toHaveLength(count)
      expect(rest).toEqual([])
    }
  })

  // With six or more: the first four, and +N for the rest. The row never scrolls.
  it('shows the first four and leaves the rest to +N from six dwarfs on', () => {
    const { shown, rest } = rosterSplit(crew(8))
    expect(shown.map((d) => d.id)).toEqual(['d0', 'd1', 'd2', 'd3'])
    expect(rest.map((d) => d.id)).toEqual(['d4', 'd5', 'd6', 'd7'])
    expect(rosterSplit(crew(6)).rest).toHaveLength(2)
  })

  it('takes a smaller row where the host asks for one', () => {
    const { shown, rest } = rosterSplit(crew(4), 3)
    expect(shown).toHaveLength(2)
    expect(rest).toHaveLength(2)
  })
})

describe('the roster copy', () => {
  it('names +N "<n> more dwarfs" and an empty mine "No dwarfs here yet."', () => {
    expect(rosterMoreLabel(4)).toBe('4 more dwarfs')
    expect(ROSTER_EMPTY).toBe('No dwarfs here yet.')
  })
})

describe('rosterMenuItems', () => {
  /*
   * The +N menu (screens/mine.md, As built): one item per remaining dwarf, labelled with its
   * name, hinted "?" while it is asking, else its status word.
   */
  it('lists each remaining dwarf by name, hinted "?" while asking, else its status word', () => {
    const items = rosterMenuItems([
      defaultDwarf({ name: 'a', status: 'working' }),
      defaultDwarf({ name: 'b', status: 'waiting', waitingReason: 'approval' }),
      defaultDwarf({ name: 'c', status: 'waiting' }),
      defaultDwarf({ name: 'd', status: 'leaving' })
    ])
    expect(items).toEqual([
      { label: 'a', hint: 'working' },
      { label: 'b', hint: '?' },
      { label: 'c', hint: 'asleep' },
      { label: 'd', hint: 'idle' }
    ])
  })
})

// Dwarf names (#635; decision log, Dwarf names): the roster names a dwarf by its custom name.
describe('rosterMenuItems, dwarf names (#635)', () => {
  it('labels a renamed dwarf with its custom name, and any other with its base name', () => {
    const items = rosterMenuItems([
      defaultDwarf({ name: 'dwarfai-55', customName: 'Watcher', status: 'working' }),
      defaultDwarf({ name: 'dwarfai-56', status: 'working' })
    ])
    expect(items.map((item) => item.label)).toEqual(['Watcher', 'dwarfai-56'])
  })
})
