import { describe, expect, it } from 'vitest'
import { MAP_SPAWN_POINTS } from './spawnPoints.generated'
import {
  MAP_ADD_LABEL,
  MAP_EMPTY_SAY,
  mapMarkerLabel,
  mapMarkers,
  mapTotals,
  mineTip
} from './mapPage'
import { defaultDwarf, defaultMaterials, defaultMine } from '../../testing/factories'
import { MATERIAL_TOKENS_PER_UNIT, type Dwarf } from '../../types'

const MINES = [
  defaultMine({ id: 'C:/dev/alpha', name: 'alpha', tier: 'bronze' }),
  defaultMine({ id: 'C:/dev/beta', name: 'beta', tier: 'gold' }),
  defaultMine({ id: 'C:/dev/gamma', name: 'gamma', tier: 'uranium' })
]

// Only the presence of a question is read here, so its shape is left empty.
const asking = defaultDwarf({
  id: 'ask',
  status: 'waiting',
  pendingQuestion: {} as NonNullable<Dwarf['pendingQuestion']>
})
const permission = defaultDwarf({ id: 'perm', status: 'waiting', waitingReason: 'approval' })
const asleep = defaultDwarf({ id: 'zzz', status: 'waiting' })
const working = defaultDwarf({ id: 'work', status: 'working' })

const byName = (name: string) => mapMarkers(MINES, null).find((m) => m.name === name)!

describe('mapMarkerLabel', () => {
  it('names the mine and its tier, and says when a dwarf there needs you', () => {
    expect(mapMarkerLabel('AI-Tools', 'gold', true)).toBe('AI-Tools, Gold, needs you')
    expect(mapMarkerLabel('ore-ledger', 'copper', false)).toBe('ore-ledger, Copper')
  })
})

/*
 * Where each marker stands. The sites are the design's 74 measured spawn points, in percent of
 * the painting, and never re-derived here (the coordinates rule): a marker takes its site's image
 * percent as it is, because the art box keeps the painting's aspect.
 */
describe('mapMarkers', () => {
  it('stands every mine on one of the design’s 74 spawn points', () => {
    for (const marker of mapMarkers(MINES, null)) {
      expect(MAP_SPAWN_POINTS.some((p) => p.x === marker.x && p.y === marker.y)).toBe(true)
    }
  })

  it('stands a mine on the spawn point the store remembers for it', () => {
    const placed = defaultMine({ id: 'C:/dev/placed', name: 'placed', mapSite: 42 })
    const point = MAP_SPAWN_POINTS.find((p) => p.id === 42)!
    const [marker] = mapMarkers([placed], null)
    expect({ x: marker!.x, y: marker!.y }).toEqual({ x: point.x, y: point.y })
  })

  /*
   * A mine main has not placed — a simulated valley, or the poll before the store's first write —
   * is still drawn, somewhere STABLE: the fallback derives from the mine's own id, so it neither
   * moves between polls nor depends on the board's order. Nothing about it is persisted.
   */
  it('places a mine the store has not placed deterministically, whatever the board’s order', () => {
    const reversed = mapMarkers([...MINES].reverse(), null)
    for (const name of ['alpha', 'beta', 'gamma']) {
      const again = reversed.find((m) => m.name === name)!
      expect({ x: again.x, y: again.y }).toEqual({ x: byName(name).x, y: byName(name).y })
    }
  })

  it('never stands two mines on the same spawn point', () => {
    const spots = mapMarkers(MINES, null).map((m) => m.x + ',' + m.y)
    expect(new Set(spots).size).toBe(spots.length)
  })

  it('draws the tier, and marks the open mine selected', () => {
    const markers = mapMarkers(MINES, 'C:/dev/beta')
    expect(markers.map((m) => [m.name, m.tier, m.selected])).toEqual([
      ['alpha', 'bronze', false],
      ['beta', 'gold', true],
      ['gamma', 'uranium', false]
    ])
  })

  it('asks for you on a mine whose dwarf waits on an answer or a permission, not on a sleeper', () => {
    const mines = [
      defaultMine({ id: 'q', name: 'q', dwarfs: [working, asking] }),
      defaultMine({ id: 'p', name: 'p', dwarfs: [permission] }),
      defaultMine({ id: 's', name: 's', dwarfs: [asleep, working] })
    ]
    expect(mapMarkers(mines, null).map((m) => [m.name, m.asking, m.label])).toEqual([
      ['q', true, 'q, Bronze, needs you'],
      ['p', true, 'p, Bronze, needs you'],
      ['s', false, 's, Bronze']
    ])
  })
})

/*
 * The mine tooltip (components.md, Tooltip card, Mine tooltip): the tier chip and the name, then
 * rows of facts. It replaces the three lines "<Tier> - Mine", the name and "Agents working: <n>".
 */
describe('mineTip', () => {
  it('titles the card with the tier and the mine’s name', () => {
    const tip = mineTip(defaultMine({ name: 'beta', tier: 'uranium' }))
    expect(tip.tier).toBe('uranium')
    expect(tip.title).toBe('beta')
  })

  /*
   * AMENDED for #635 (PANEL-QUESTIONS 11, design lead ruling 2026-09-27; was: "counts the dwarfs
   * awake there as working, ...", expecting "Dwarfs working" 3). "Dwarfs working" counts only the
   * dwarfs whose status is working; one that needs you is counted in its own row alone.
   */
  it('counts only the working dwarfs as working, and the ones that need you in their own row', () => {
    const tip = mineTip(defaultMine({ dwarfs: [working, asking, asleep, working] }))
    // AMENDED for ISSUE-256 (screens/map.md, the row in --brass; was: no tone): counts unchanged.
    expect(tip.rows).toEqual([
      { label: 'Dwarfs working', value: '2' },
      { label: 'Needs you', value: '1', tone: 'brass' }
    ])
  })

  // APPENDED for #635 (PANEL-QUESTIONS 11): asleep and leaving dwarfs are in neither row, and a
  // working dwarf that asked something needs you rather than counting as working.
  it('counts a sleeper or a leaver in neither row, and an asking worker only as needing you', () => {
    const leaving = defaultDwarf({ id: 'bye', status: 'leaving' })
    const workingAsker = defaultDwarf({
      id: 'wask',
      status: 'working',
      pendingQuestion: {} as NonNullable<Dwarf['pendingQuestion']>
    })
    expect(mineTip(defaultMine({ dwarfs: [asleep, leaving] })).rows).toEqual([
      { label: 'Dwarfs working', value: '0' }
    ])
    // AMENDED for ISSUE-256 (screens/map.md, the row in --brass; was: no tone): counts unchanged.
    expect(mineTip(defaultMine({ dwarfs: [workingAsker, permission] })).rows).toEqual([
      { label: 'Dwarfs working', value: '0' },
      { label: 'Needs you', value: '2', tone: 'brass' }
    ])
  })

  it('shows no needs-you row while nobody waits on you', () => {
    const tip = mineTip(defaultMine({ dwarfs: [working] }))
    expect(tip.rows).toEqual([{ label: 'Dwarfs working', value: '1' }])
  })

  it('says a mine nobody is working has no dwarfs working', () => {
    expect(mineTip(defaultMine({ dwarfs: [] })).rows).toEqual([
      { label: 'Dwarfs working', value: '0' }
    ])
  })
})

/*
 * The totals plate: the WHOLE vault by material (main sums it over the entire ledger, so it holds
 * ore no mine on screen produces, #22), each material its own counter in its own units, never
 * converted and never summed across materials.
 */
describe('mapTotals', () => {
  it('turns each material’s tokens into its own units, poorest first', () => {
    const totals = mapTotals(
      defaultMaterials({
        coal: 3 * MATERIAL_TOKENS_PER_UNIT.coal,
        gold: 2 * MATERIAL_TOKENS_PER_UNIT.gold
      })
    )
    expect(totals).toEqual([
      { material: 'coal', units: 3 },
      { material: 'gold', units: 2 }
    ])
  })

  it('is empty before any breakdown has arrived', () => {
    expect(mapTotals(undefined)).toEqual([])
  })
})

describe('the first-run card', () => {
  it('says what to do, with the one action there is', () => {
    expect(MAP_EMPTY_SAY).toBe('No mines yet. Add a project folder to start.')
    expect(MAP_ADD_LABEL).toBe('Add a mine')
  })
})

// PANEL-QUESTIONS 6: the marker's tooltip adds "Not enterable" for a mine whose folder is gone.
describe('mineTip, a mine that cannot be entered', () => {
  it('adds the row "Not enterable", warned', () => {
    const tip = mineTip(defaultMine({ name: 'old' }), { notEnterable: true })
    expect(tip.rows.at(-1)).toEqual({ label: 'Not enterable', value: '', tone: 'warn' })
    expect(
      mineTip(defaultMine({ name: 'old' })).rows.some((r) => r.label === 'Not enterable')
    ).toBe(false)
  })
})

/*
 * ISSUE-256: the marker tooltip and the marker's name against US-MAP-001 and US-MAP-002, read with
 * the pinned design (d12d3fc, screens/map.md and organisms/map-page).
 */
describe('mineTip, ISSUE-256', () => {
  it('[US-MAP-001.AC03] the working count counts only dwarfs whose status is working', () => {
    const leaving = defaultDwarf({ id: 'bye', status: 'leaving' })
    const tip = mineTip(defaultMine({ dwarfs: [working, asking, permission, asleep, leaving] }))
    expect(tip.rows[0]).toEqual({ label: 'Dwarfs working', value: '1' })
  })

  /*
   * Accepted difference (design wins, recorded in the PR): US-MAP-001.AC02 words the row
   * "1 needs you" / "<n> need you". The pinned design draws the map tooltip's row as the label
   * "Needs you" with the count as its value (screens/map.md: 'then "Needs you" with the needs-you
   * count, only when it is not zero'; map-page.js tipFor), ruled for this tooltip in PANEL-QUESTIONS
   * 11. The decision log's "Needs-you count wording" names its places (the card pill, the Valle
   * counter, accessible names) and the map tooltip is not among them. Either way the count is text.
   */
  it('[US-MAP-001.AC02, US-MAP-001.AC06, NFR-A11Y-08] the needs-you row reads 1 needs you or n need you as label text', () => {
    // In --brass, as the design draws it; the count is still the row's text.
    expect(mineTip(defaultMine({ dwarfs: [asking] })).rows[1]).toEqual({
      label: 'Needs you',
      value: '1',
      tone: 'brass'
    })
    expect(mineTip(defaultMine({ dwarfs: [asking, permission] })).rows[1]).toEqual({
      label: 'Needs you',
      value: '2',
      tone: 'brass'
    })
    expect(mineTip(defaultMine({ dwarfs: [working] })).rows.map((r) => r.label)).toEqual([
      'Dwarfs working'
    ])
  })

  it('[US-MAP-001.AC04, US-MAP-001.AC05, US-MAP-003.AC02] Measuring… and Not enterable rows are added beside the working and needs-you rows, never instead of them, Not enterable in the warn colour', () => {
    const mine = defaultMine({ dwarfs: [working, asking] })
    expect(mineTip(mine, { measuring: true }).rows).toEqual([
      { label: 'Dwarfs working', value: '1' },
      { label: 'Needs you', value: '1', tone: 'brass' },
      { label: 'Measuring…', value: '' }
    ])
    expect(mineTip(mine, { measuring: true, notEnterable: true }).rows).toEqual([
      { label: 'Dwarfs working', value: '1' },
      { label: 'Needs you', value: '1', tone: 'brass' },
      { label: 'Measuring…', value: '' },
      { label: 'Not enterable', value: '', tone: 'warn' }
    ])
  })
})

describe('mapMarkerLabel, ISSUE-256', () => {
  it('[US-MAP-002.AC06, US-MAP-002.AC07] a marker is named by its name and tier with needs you added, or Tier mine when unnamed', () => {
    expect(mapMarkerLabel('AI-Tools', 'gold', false)).toBe('AI-Tools, Gold')
    expect(mapMarkerLabel('AI-Tools', 'gold', true)).toBe('AI-Tools, Gold, needs you')
    expect(mapMarkerLabel('', 'copper', false)).toBe('Copper mine')
    expect(mapMarkerLabel('  ', 'silver', true)).toBe('Silver mine, needs you')
  })
})
