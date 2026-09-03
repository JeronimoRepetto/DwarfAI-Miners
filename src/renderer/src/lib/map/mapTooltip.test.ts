import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import { MAP_TOOLTIP_SIZE, mineTooltipCopy, placeMapTooltip } from './mapTooltip'

const BOX = { width: 460, height: 600 }

describe('mineTooltipCopy', () => {
  it('says the tier, the project and the crew, in the design’s own words', () => {
    const copy = mineTooltipCopy(
      defaultMine({ tier: 'uranium', name: 'forge', dwarfs: [defaultDwarf(), defaultDwarf()] })
    )
    expect(copy).toEqual({ tier: 'Uranium - Mine', name: 'forge', agents: 'Agents working: 2' })
  })

  /*
    AMENDED for #165: `Cropper` stood here as the "confirmed, deliberate"
    product label from #90 until the maintainer reversed that ruling on
    2026-09-03 — it was never meant to survive, and the English word is
    `Copper`. This pins the reversed spelling; see presentation.ts for why.
  */
  it('spells the copper tier Copper, as every other rebuilt surface does', () => {
    expect(mineTooltipCopy(defaultMine({ tier: 'copper' })).tier).toBe('Copper - Mine')
  })

  it('says zero rather than nothing for a mine with no crew', () => {
    expect(mineTooltipCopy(defaultMine({ dwarfs: [] })).agents).toBe('Agents working: 0')
  })

  /*
    The drawing tier, deliberately. `mine.tier` is what main stamped for
    DRAWING — a provisional bronze until the project's first walk finishes
    (#41) — and a tooltip is a label on a marker, not a record of a decision.
    Nothing here reaches knownTier, and nothing here is written down.
  */
  it('labels an unwalked mine with the tier it is drawn as', () => {
    expect(mineTooltipCopy(defaultMine({ tier: 'bronze' })).tier).toBe('Bronze - Mine')
  })
})

describe('placeMapTooltip', () => {
  it('is the design’s size', () => {
    expect(MAP_TOOLTIP_SIZE).toEqual({ width: 170, height: 60 })
  })

  it('sits above and to the right of the marker, as the design shows it', () => {
    const placed = placeMapTooltip({ x: 200, y: 300 }, BOX)
    expect(placed.left).toBeGreaterThan(200)
    expect(placed.top).toBeLessThan(300 - MAP_TOOLTIP_SIZE.height)
  })

  /*
    Edge behaviour is marked **Unspecified** by the design — its own map
    container never crops, and the tooltip in the export has room. Ours is a
    resizable panel and a marker can sit two pixels from a corner, so this is a
    decision: hold the whole tooltip inside the container. Half a tooltip cut
    off by the panel edge is the one outcome that loses information.
  */
  it('never lets the tooltip leave the container', () => {
    for (const marker of [
      { x: 0, y: 0 },
      { x: BOX.width, y: 0 },
      { x: 0, y: BOX.height },
      { x: BOX.width, y: BOX.height },
      { x: BOX.width / 2, y: 4 }
    ]) {
      const placed = placeMapTooltip(marker, BOX)
      expect(placed.left, `left for ${marker.x},${marker.y}`).toBeGreaterThanOrEqual(0)
      expect(placed.top, `top for ${marker.x},${marker.y}`).toBeGreaterThanOrEqual(0)
      expect(placed.left + MAP_TOOLTIP_SIZE.width).toBeLessThanOrEqual(BOX.width)
      expect(placed.top + MAP_TOOLTIP_SIZE.height).toBeLessThanOrEqual(BOX.height)
    }
  })

  it('drops the tooltip below a marker too near the top for it to sit above', () => {
    const placed = placeMapTooltip({ x: 200, y: 6 }, BOX)
    expect(placed.top).toBeGreaterThanOrEqual(0)
    expect(placed.top).toBeLessThan(BOX.height)
  })

  it('pins it to the left edge rather than off it in a box narrower than the tooltip', () => {
    const placed = placeMapTooltip({ x: 40, y: 200 }, { width: 120, height: 400 })
    expect(placed.left).toBe(0)
  })
})
