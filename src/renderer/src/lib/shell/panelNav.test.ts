import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import { GUILD_SLOTS, SYSTEM_SLOTS, WORLD_SLOTS, needsYouCount, reachableArea } from './panelNav'
import { SHELL_AREAS } from './shellNav'

const question = {
  toolUseId: 'tool-1',
  channel: 'held' as const,
  questions: [{ question: 'Which branch?', multiSelect: false, options: [{ label: 'main' }] }]
}

describe('the Panel nav’s groups', () => {
  it('holds Map and Mines in the World group, in that order', () => {
    expect(WORLD_SLOTS.map((slot) => [slot.area, slot.label, slot.icon])).toEqual([
      ['map', 'Map', 'map'],
      ['mines', 'Mines', 'mines']
    ])
  })

  it('holds Lab, Market and Laboral Union in the Guild group', () => {
    expect(GUILD_SLOTS.map((slot) => [slot.area, slot.label, slot.icon])).toEqual([
      ['lab', 'Lab', 'lab'],
      ['market', 'Market', 'market'],
      ['laboral-union', 'Laboral Union', 'union']
    ])
  })

  it('holds Settings in the System group, ahead of the music toggle', () => {
    expect(SYSTEM_SLOTS.map((slot) => [slot.area, slot.label, slot.icon])).toEqual([
      ['settings', 'Settings', 'settings']
    ])
  })

  it('gives every area exactly one slot', () => {
    // Taken over from shellNav's SHELL_NAV list, which went with the v4 nav.
    const areas = [...WORLD_SLOTS, ...GUILD_SLOTS, ...SYSTEM_SLOTS].map((slot) => slot.area)
    expect([...areas].sort()).toEqual([...SHELL_AREAS].sort())
  })

  it('names each slot by the design’s own slot id', () => {
    const ids = [...WORLD_SLOTS, ...GUILD_SLOTS, ...SYSTEM_SLOTS].map((slot) => slot.id)
    expect(ids).toEqual(['map', 'mines', 'lab', 'market', 'union', 'settings'])
  })
})

describe('needsYouCount', () => {
  it('counts every dwarf, across every mine, that a question or a permission is waiting on', () => {
    const mines = [
      defaultMine({
        id: 'a',
        dwarfs: [
          defaultDwarf({ id: 'q', status: 'waiting', pendingQuestion: question }),
          defaultDwarf({ id: 'w', status: 'working' })
        ]
      }),
      defaultMine({
        id: 'b',
        dwarfs: [defaultDwarf({ id: 'p', status: 'waiting', waitingReason: 'approval' })]
      })
    ]
    expect(needsYouCount(mines)).toBe(2)
  })

  it('never counts a dwarf that is merely resting', () => {
    // A rest is not a request: only a proven question or permission needs you.
    const mines = [
      defaultMine({
        dwarfs: [
          defaultDwarf({ id: 'r', status: 'waiting' }),
          defaultDwarf({ id: 'u', status: 'waiting', waitingReason: 'unknown' })
        ]
      })
    ]
    expect(needsYouCount(mines)).toBe(0)
  })

  it('counts a dwarf once even when it asks and waits on a permission at the same time', () => {
    const mines = [
      defaultMine({
        dwarfs: [
          defaultDwarf({
            id: 'both',
            status: 'waiting',
            waitingReason: 'approval',
            pendingQuestion: question
          })
        ]
      })
    ]
    expect(needsYouCount(mines)).toBe(1)
  })
})

describe('reachableArea', () => {
  it('keeps any area while the guild areas are shown', () => {
    expect(reachableArea('lab', true)).toBe('lab')
    expect(reachableArea('mines', true)).toBe('mines')
  })

  it('leaves a guild area for the map while they are hidden: nothing may point at them', () => {
    for (const area of ['lab', 'market', 'laboral-union'] as const) {
      expect(reachableArea(area, false)).toBe('map')
    }
    expect(reachableArea('settings', false)).toBe('settings')
  })
})
