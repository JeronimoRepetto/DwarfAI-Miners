/*
 * What the Map page shows (#635), `organisms/map-page` in the design (W5): every mine as a tier
 * marker on its measured site, the "?" marker for a mine that needs you, the tooltip each marker
 * shows, the ore totals and the first-run card. The page component draws; this decides.
 *
 * ## Where a marker stands
 *
 * On one of the design's 74 measured spawn points, in percent of the painting (1856 x 2304), taken
 * as they are: `spawnPoints.generated.ts` is generated and its numbers are never re-derived here
 * (.claude/rules/coordinates.md). The page's art box carries the painting's own aspect, so image
 * percent is box percent; the page still runs each point through `projectToMapBox` against the
 * measured box, which leaves it as it is for a box of that shape.
 *
 * ## What a marker may claim
 *
 * The tier is the one the board stamped for DRAWING, a provisional Bronze for a mine nobody has
 * measured (#41): right for a marker, which records nothing.
 */
import { assignSlots } from '../placement'
import { designTierLabel } from '../presentation'
import { dwarfNeedsYou } from '../shell/panelNav'
import { vaultRows } from '../vault/vault'
import type { TipRow } from '../overlay/tipCard'
import type { VaultStripOre } from '../vault/vaultStrip'
import { MAP_SPAWN_POINTS, type MapSpawnPoint } from './spawnPoints.generated'
import type { MaterialTotals, Mine, MineTier } from '../../types'

/** The first-run card's one sentence (decision log, First run: add a mine). */
export const MAP_EMPTY_SAY = 'No mines yet. Add a project folder to start.'

/** Its one action: the same "Add a mine" as the Mines page. */
export const MAP_ADD_LABEL = 'Add a mine'

export interface MapMarkerView {
  id: string
  name: string
  tier: MineTier
  /** A dwarf there waits on the person: the "?" marker, attention level 1 on the map. */
  asking: boolean
  /** Its mine is open in the mine column. */
  selected: boolean
  /** "<name>, <Tier>[, needs you]". */
  label: string
  /** The site, in percent of the painting. */
  x: number
  y: number
}

export function mapMarkerLabel(name: string, tier: MineTier, asking: boolean): string {
  return name + ', ' + designTierLabel(tier) + (asking ? ', needs you' : '')
}

// Spawn points by their own id: the id is what the store persists, the array order only a drawing
// order. Built once, because the table is generated and never changes at run time.
const POINT_BY_ID = new Map(MAP_SPAWN_POINTS.map((point) => [point.id, point]))

/**
 * Each mine's site: the one the store remembers, else a slot hashed from the mine's own id among
 * the mines nobody has placed — a simulated valley (#42), or a project in the poll before its
 * first row is written. The hash runs over the unplaced mines only, so a placed mine never pushes
 * one around, and it depends on no order, so the same mine lands in the same spot every poll.
 */
function sitesOf(mines: readonly Mine[]): Map<string, MapSpawnPoint> {
  const unplaced = mines.filter(
    (mine) => mine.mapSite === undefined || !POINT_BY_ID.has(mine.mapSite)
  )
  const slots = assignSlots(
    unplaced.map((mine) => mine.id),
    MAP_SPAWN_POINTS.length
  )
  const sites = new Map<string, MapSpawnPoint>()
  for (const mine of mines) {
    const remembered = mine.mapSite === undefined ? undefined : POINT_BY_ID.get(mine.mapSite)
    sites.set(
      mine.id,
      remembered ?? MAP_SPAWN_POINTS[slots.get(mine.id) ?? 0] ?? MAP_SPAWN_POINTS[0]!
    )
  }
  return sites
}

export function mapMarkers(mines: readonly Mine[], openId: string | null): MapMarkerView[] {
  const sites = sitesOf(mines)
  return mines.map((mine) => {
    const asking = mine.dwarfs.some(dwarfNeedsYou)
    const site = sites.get(mine.id)!
    return {
      id: mine.id,
      name: mine.name,
      tier: mine.tier,
      asking,
      selected: mine.id === openId,
      label: mapMarkerLabel(mine.name, mine.tier, asking),
      x: site.x,
      y: site.y
    }
  })
}

export interface MineTip {
  tier: MineTier
  title: string
  rows: TipRow[]
}

/**
 * The mine tooltip: the tier chip and the name, "Dwarfs working", and "Needs you" while any dwarf
 * there waits on you (PANEL-QUESTIONS 11, design lead ruling 2026-09-27). "Dwarfs working" counts
 * only the dwarfs whose status is working; one that needs you is counted in its own row and never
 * in both, as the mine card's crew line counts it. Asleep and leaving dwarfs are in neither.
 */
export function mineTip(mine: Mine, facts: { notEnterable?: boolean } = {}): MineTip {
  const needs = mine.dwarfs.filter(dwarfNeedsYou).length
  const working = mine.dwarfs.filter((d) => d.status === 'working' && !dwarfNeedsYou(d)).length
  const rows: TipRow[] = [{ label: 'Dwarfs working', value: String(working) }]
  if (needs > 0) rows.push({ label: 'Needs you', value: String(needs) })
  // A mine whose folder no longer exists (PANEL-QUESTIONS 6; screens/map.md).
  if (facts.notEnterable) rows.push({ label: 'Not enterable', value: '', tone: 'warn' })
  return { tier: mine.tier, title: mine.name, rows }
}

/**
 * The totals plate: the WHOLE vault by material, as main sums it over the entire ledger (#22),
 * each material its own counter in its own units.
 */
export function mapTotals(materials: MaterialTotals | undefined): VaultStripOre[] {
  return vaultRows(materials).map(({ material, units }) => ({ material, units }))
}
