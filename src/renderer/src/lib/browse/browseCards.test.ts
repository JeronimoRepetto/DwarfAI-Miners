import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import type { ProjectSummary } from '../../types'
import { MINE_TIERS, TIER_WEIGHT_THRESHOLDS_KB } from '../../types'
import {
  TIER_CHIPS,
  activeAgentsFor,
  browseTierLabel,
  cardArtFor,
  cardStatusFor,
  cardTierFor,
  cardTierLabel,
  nextLevelFor
} from './browseCards'

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'C:/dev/sample',
    path: 'C:/dev/sample',
    name: 'sample',
    declared: false,
    addedAt: 0,
    live: false,
    ...overrides
  }
}

describe('browseTierLabel', () => {
  // AMENDED for #165: the maintainer reversed the earlier "Cropper is
  // confirmed and deliberate" ruling on 2026-09-03 — it was never meant to
  // survive. This pinned 'Cropper'; it now pins the English word instead.
  it("spells the copper tier 'Copper', as the maintainer ruled (#165)", () => {
    expect(browseTierLabel('copper')).toBe('Copper')
  })

  it('names every other tier as the design writes it', () => {
    expect(browseTierLabel('bronze')).toBe('Bronze')
    expect(browseTierLabel('silver')).toBe('Silver')
    expect(browseTierLabel('gold')).toBe('Gold')
    expect(browseTierLabel('uranium')).toBe('Uranium')
  })

  // #165: the wire identifier was never 'Cropper' — it has always been the
  // lowercase 'copper' MineTier value. Only the display label changed; this
  // pins that the two are independent, so a future label correction never
  // touches the wire spelling by accident.
  it("keeps the wire tier spelled 'copper' regardless of what the label says", () => {
    expect(MINE_TIERS).toContain('copper')
    expect(cardTierFor(project({ weightBytes: 100 * 1024 }))).toBe('copper')
  })
})

describe('TIER_CHIPS', () => {
  it('leads with All, which filters nothing', () => {
    expect(TIER_CHIPS[0]).toEqual({ tier: null, label: 'All' })
  })

  it('lists the tiers poorest first', () => {
    expect(TIER_CHIPS.map((chip) => chip.label)).toEqual([
      'All',
      'Bronze',
      'Copper',
      'Silver',
      'Gold',
      'Uranium'
    ])
  })

  it('offers a chip for every tier a mine can be', () => {
    expect(TIER_CHIPS.slice(1).map((chip) => chip.tier)).toEqual([...MINE_TIERS])
  })
})

/*
 * #153's seventh correction. A declared folder's card drew the level bar and no
 * tier and no art, and the reason was a join: the bar reads `weightBytes`, which
 * the tier walk's own cache publishes for anything it has weighed, while the
 * label and the painting read `knownTier`, which the projects store only fills
 * while a mine is actually being WORKED. So a card could state how far the mine
 * had climbed without being willing to say which tier it was in.
 *
 * A measured weight IS a classification — it is the very number `tierForBytes`
 * classifies in main — so the card derives the tier from it rather than printing
 * half the fact. Absence still claims nothing: no weight, no tier, no art.
 */
describe('cardTierFor', () => {
  it('prefers the tier a walk actually recorded', () => {
    // Even where the weight would say otherwise: `knownTier` is the store's own
    // record of a classification, and a derivation must never overrule it.
    expect(cardTierFor(project({ knownTier: 'gold', weightBytes: 1 }))).toBe('gold')
  })

  it('classifies a measured weight the store has no tier for', () => {
    const kb = 1024
    expect(cardTierFor(project({ weightBytes: 0 }))).toBe('bronze')
    expect(cardTierFor(project({ weightBytes: 99 * kb }))).toBe('bronze')
    expect(cardTierFor(project({ weightBytes: 100 * kb }))).toBe('copper')
    expect(cardTierFor(project({ weightBytes: 500 * kb }))).toBe('silver')
    expect(cardTierFor(project({ weightBytes: 2048 * kb }))).toBe('gold')
    expect(cardTierFor(project({ weightBytes: 8192 * kb }))).toBe('uranium')
    expect(cardTierFor(project({ weightBytes: 99_999 * kb }))).toBe('uranium')
  })

  it('reads the boundaries exactly as main’s own tierForBytes does', () => {
    // The two are one classification of one measurement, so the >= comparisons
    // and the bracket order have to match tierForBytes in main/tier/tierService.
    const { copperKb, silverKb, goldKb, uraniumKb } = TIER_WEIGHT_THRESHOLDS_KB
    for (const [kb, tier] of [
      [copperKb - 1, 'bronze'],
      [copperKb, 'copper'],
      [silverKb - 1, 'copper'],
      [silverKb, 'silver'],
      [goldKb - 1, 'silver'],
      [goldKb, 'gold'],
      [uraniumKb - 1, 'gold'],
      [uraniumKb, 'uranium']
    ] as const) {
      expect(cardTierFor(project({ weightBytes: kb * 1024 })), `${kb}KB`).toBe(tier)
    }
  })

  it('claims nothing at all for a project no walk has weighed', () => {
    expect(cardTierFor(project())).toBeUndefined()
  })
})

describe('cardTierLabel', () => {
  it('names the tier a walk has measured', () => {
    expect(cardTierLabel(project({ knownTier: 'gold' }))).toBe('Gold')
  })

  it('names the tier the measured weight puts this project in', () => {
    expect(cardTierLabel(project({ weightBytes: 600 * 1024 }))).toBe('Silver')
  })

  it('claims no tier for a project nobody has measured yet', () => {
    // tierOf()'s provisional bronze is for drawing a mound, never for stating
    // a fact on a card (#41): an unmeasured project reads as unmeasured. What
    // changed with #153 is only what counts as measured — a weight does.
    expect(cardTierLabel(project())).toBeUndefined()
  })
})

describe('cardArtFor', () => {
  it('paints the entrance of the measured tier', () => {
    expect(cardArtFor(project({ knownTier: 'uranium' }))).toBeTruthy()
    expect(cardArtFor(project({ knownTier: 'uranium' }))).not.toBe(
      cardArtFor(project({ knownTier: 'bronze' }))
    )
  })

  it('paints the entrance the weight classifies when the store has no tier', () => {
    // The same painting either way round, so a card that derived its tier and
    // one that was told it are the same card — which is what puts the art
    // column back and lines the level bar up with its neighbours again.
    expect(cardArtFor(project({ weightBytes: 3000 * 1024 }))).toBe(
      cardArtFor(project({ knownTier: 'gold' }))
    )
  })

  it('paints nothing for an unmeasured project rather than guessing a tier', () => {
    expect(cardArtFor(project())).toBeUndefined()
  })
})

describe('activeAgentsFor', () => {
  const mines = [
    defaultMine({
      id: 'C:/dev/alpha',
      dwarfs: [defaultDwarf({ id: 'a' }), defaultDwarf({ id: 'b' })]
    }),
    defaultMine({ id: 'C:/dev/beta', dwarfs: [] })
  ]

  it('counts the crew of the matching mine on the board', () => {
    expect(activeAgentsFor(project({ id: 'C:/dev/alpha', live: true }), mines)).toBe(2)
  })

  it('reports an empty crew as zero, which the board can honestly say', () => {
    expect(activeAgentsFor(project({ id: 'C:/dev/beta', live: true }), mines)).toBe(0)
  })

  it('says nothing about a project that is not live', () => {
    expect(activeAgentsFor(project({ id: 'C:/dev/alpha', live: false }), mines)).toBeUndefined()
  })

  it('says nothing when the board has no mine under that id yet', () => {
    // live is stamped by the poll that answered the browse; the snapshot the
    // panel holds may be one poll behind, and a count of 0 would then be a
    // claim the panel cannot back.
    expect(activeAgentsFor(project({ id: 'C:/dev/gamma', live: true }), mines)).toBeUndefined()
  })
})

/*
 * The two status markers the mock puts in a card's lower-right corner (#135).
 * Both are joined off the board exactly as the crew count is, and both read
 * facts the panel ALREADY draws elsewhere — the question the message panel
 * answers, and the `z z z` the sprite floats over a resting dwarf.
 */
describe('cardStatusFor', () => {
  const asking = defaultDwarf({
    id: 'asking',
    status: 'waiting',
    pendingQuestion: {
      toolUseId: 'tool-1',
      question: 'Which branch?',
      multiSelect: false,
      options: [{ label: 'main' }]
    }
  })

  it('marks a project whose agent is asking its user something', () => {
    const mines = [defaultMine({ id: 'C:/dev/alpha', dwarfs: [asking] })]
    expect(cardStatusFor(project({ id: 'C:/dev/alpha', live: true }), mines)?.asking).toBe(true)
  })

  it('marks a project with a resting agent on it', () => {
    const mines = [
      defaultMine({ id: 'C:/dev/alpha', dwarfs: [defaultDwarf({ status: 'waiting' })] })
    ]
    expect(cardStatusFor(project({ id: 'C:/dev/alpha', live: true }), mines)?.resting).toBe(true)
  })

  it('marks neither for a crew that is simply working', () => {
    const mines = [
      defaultMine({ id: 'C:/dev/alpha', dwarfs: [defaultDwarf({ status: 'working' })] })
    ]
    expect(cardStatusFor(project({ id: 'C:/dev/alpha', live: true }), mines)).toEqual({
      asking: false,
      resting: false
    })
  })

  it('does not read a departure as rest', () => {
    const mines = [
      defaultMine({ id: 'C:/dev/alpha', dwarfs: [defaultDwarf({ status: 'leaving' })] })
    ]
    expect(cardStatusFor(project({ id: 'C:/dev/alpha', live: true }), mines)?.resting).toBe(false)
  })

  it('needs only one agent of a crew to raise a marker', () => {
    const mines = [
      defaultMine({
        id: 'C:/dev/alpha',
        dwarfs: [defaultDwarf({ id: 'busy', status: 'working' }), asking]
      })
    ]
    expect(cardStatusFor(project({ id: 'C:/dev/alpha', live: true }), mines)).toEqual({
      asking: true,
      resting: true
    })
  })

  it('says nothing at all about a project that is not live', () => {
    const mines = [defaultMine({ id: 'C:/dev/alpha', dwarfs: [asking] })]
    expect(cardStatusFor(project({ id: 'C:/dev/alpha', live: false }), mines)).toBeUndefined()
  })

  it('says nothing when the board has no mine under that id yet', () => {
    // Same one-poll lag activeAgentsFor guards: no mine on the board is an
    // absence of evidence, and "no markers" would be a claim about a crew the
    // panel has not seen.
    expect(cardStatusFor(project({ id: 'C:/dev/gamma', live: true }), [])).toBeUndefined()
  })

  it('reports an empty crew as neither asking nor resting', () => {
    const mines = [defaultMine({ id: 'C:/dev/beta', dwarfs: [] })]
    expect(cardStatusFor(project({ id: 'C:/dev/beta', live: true }), mines)).toEqual({
      asking: false,
      resting: false
    })
  })
})

/*
 * The bar/label #135's rebuild left as a seam, closed by #140 landing
 * ProjectSummary.weightBytes (#90). cur is weightBytes rounded to the nearest
 * whole KB (Math.round — ties round up), the same rounding tierService.ts's
 * own debug KB display already uses. The bracket boundaries are the CLEAN
 * TIER_WEIGHT_THRESHOLDS_KB figures (100/500/2048/8192): the mock's own
 * printed maximums (99/499) are one off the clean numbers for bronze/copper
 * and already clean for silver/gold, an inconsistency the foundations table
 * resolves in the clean numbers' favour (#90).
 */
describe('nextLevelFor', () => {
  it('says nothing for a project no walk has weighed yet', () => {
    // Absence over invention, same as every other unmeasured field on this
    // card: a bar with an invented denominator is worse than no bar at all.
    expect(nextLevelFor(undefined)).toBeUndefined()
  })

  it('reads the bronze bracket toward the clean 100KB boundary', () => {
    expect(nextLevelFor(80 * 1024)).toEqual({ currentKb: 80, nextBoundaryKb: 100, ratio: 0.8 })
  })

  it('rounds the byte weight to the nearest whole KB, ties rounding up', () => {
    expect(nextLevelFor(Math.round(80.6 * 1024))?.currentKb).toBe(81)
    expect(nextLevelFor(Math.round(80.4 * 1024))?.currentKb).toBe(80)
  })

  it("crosses into the next bracket at the clean 100KB boundary, not the mock's own 99", () => {
    expect(nextLevelFor(100 * 1024)).toEqual({ currentKb: 100, nextBoundaryKb: 500, ratio: 0.2 })
  })

  it('stays in the bronze bracket one byte short of the boundary', () => {
    expect(nextLevelFor(100 * 1024 - 1)?.nextBoundaryKb).toBe(100)
  })

  it('reads the silver bracket toward the clean 2048KB boundary', () => {
    expect(nextLevelFor(1724 * 1024)).toEqual({
      currentKb: 1724,
      nextBoundaryKb: 2048,
      ratio: 1724 / 2048
    })
  })

  it('reads the gold bracket toward the clean 8192KB boundary', () => {
    expect(nextLevelFor(3121 * 1024)).toEqual({
      currentKb: 3121,
      nextBoundaryKb: 8192,
      ratio: 3121 / 8192
    })
  })

  it('reports uranium as unbounded, matching the mock printing infinite', () => {
    // Uranium has no next tier to climb toward, so there is no boundary to
    // divide by — the card prints "infinite" for exactly this undefined.
    const progress = nextLevelFor(10975 * 1024)
    expect(progress?.currentKb).toBe(10975)
    expect(progress?.nextBoundaryKb).toBeUndefined()
  })

  it('draws no fill once a mine has run past its ceiling', () => {
    expect(nextLevelFor(10975 * 1024)?.ratio).toBe(0)
  })

  it('reads a full bar, not an error, when KB-rounding lands cur on a boundary it has not technically reached', () => {
    // 101_990 bytes is 99.60...KB — still short of the 100KB copper cut — but
    // rounds up to a displayed 100. This is the one case the [0,1] clamp
    // guards: cur can equal nextBoundaryKb through rounding alone, and this
    // pins that it reads as a full bar (ratio 1) rather than anything past it.
    // The clamp itself stays unproven by this suite — cur is derived from the
    // SAME bracket boundary as nextBoundaryKb, so it can reach but never
    // mathematically exceed it under the current formula; the clamp is
    // defensive against a future change to that formula, not load-bearing today.
    const weightBytes = Math.round(99.6 * 1024)
    const progress = nextLevelFor(weightBytes)
    expect(progress).toEqual({ currentKb: 100, nextBoundaryKb: 100, ratio: 1 })
  })
})
