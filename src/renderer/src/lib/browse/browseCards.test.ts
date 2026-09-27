import { describe, expect, it } from 'vitest'
import type { ProjectSummary } from '../../types'
import { TIER_WEIGHT_THRESHOLDS_KB } from '../../types'
import { cardTierFor, isMeasuring, nextLevelFor } from './browseCards'

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

/*
 * REMOVED for #635 (PR2), with the helpers the retired MineCard and MinesPanel were the only
 * callers of (see browseCards.ts). Where each guarantee lives now:
 * - browseTierLabel (Copper spelled as ruled, #165; every tier as the design writes it; the wire
 *   keeps 'copper'): designTierLabel in lib/presentation.ts, whose own tests hold the spelling.
 * - TIER_CHIPS (All first, poorest first, every tier): MinesList.test.ts, "is a section named
 *   Mines: the page header, the tier chips, the list and its foot".
 * - cardTierLabel and cardArtFor (the measured tier, or the weight's; nothing claimed for an
 *   unmeasured project): lib/browse/mineCard.test.ts, "states a measured mine's tier…" and "draws a
 *   declared mine nobody has measured as Bronze, measuring, and never as a fact" (the placeholder
 *   is the design's first-run ruling; `measured` keeps it from answering a tier filter).
 * - activeAgentsFor and cardStatusFor (the crew from the board, nothing for a project not live or
 *   not on the board yet, asking and resting read from the board's own fields): the crew line,
 *   crewPills and mineCardView in lib/browse/mineCard.test.ts ("counts working, needs you and
 *   asleep…", "claims no crew for a live mine the board has not caught up with yet", "says No
 *   dwarfs for a remembered mine nobody is working…").
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
    expect(cardTierFor(project({ weightBytes: 350 * kb }))).toBe('copper')
    expect(cardTierFor(project({ weightBytes: 1500 * kb }))).toBe('silver')
    expect(cardTierFor(project({ weightBytes: 12000 * kb }))).toBe('gold')
    expect(cardTierFor(project({ weightBytes: 100000 * kb }))).toBe('uranium')
    expect(cardTierFor(project({ weightBytes: 100_000 * kb }))).toBe('uranium')
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

describe('nextLevelFor', () => {
  it('says nothing for a project no walk has weighed yet', () => {
    // Absence over invention, same as every other unmeasured field on this
    // card: a bar with an invented denominator is worse than no bar at all.
    expect(nextLevelFor(undefined)).toBeUndefined()
  })

  it('reads the bronze bracket toward the clean 350KB boundary', () => {
    expect(nextLevelFor(80 * 1024)).toEqual({ currentKb: 80, nextBoundaryKb: 350, ratio: 80 / 350 })
  })

  it('rounds the byte weight to the nearest whole KB, ties rounding up', () => {
    expect(nextLevelFor(Math.round(80.6 * 1024))?.currentKb).toBe(81)
    expect(nextLevelFor(Math.round(80.4 * 1024))?.currentKb).toBe(80)
  })

  it("crosses into the next bracket at the clean 350KB boundary, not the mock's own 349", () => {
    expect(nextLevelFor(350 * 1024)).toEqual({
      currentKb: 350,
      nextBoundaryKb: 1500,
      ratio: 350 / 1500
    })
  })

  it('stays in the bronze bracket one byte short of the boundary', () => {
    expect(nextLevelFor(350 * 1024 - 1)?.nextBoundaryKb).toBe(350)
  })

  it('reads the silver bracket toward the clean 12000KB boundary', () => {
    expect(nextLevelFor(5000 * 1024)).toEqual({
      currentKb: 5000,
      nextBoundaryKb: 12000,
      ratio: 5000 / 12000
    })
  })

  it('reads the gold bracket toward the clean 100000KB boundary', () => {
    expect(nextLevelFor(50000 * 1024)).toEqual({
      currentKb: 50000,
      nextBoundaryKb: 100000,
      ratio: 50000 / 100000
    })
  })

  it('reports uranium as unbounded, matching the mock printing infinite', () => {
    // Uranium has no next tier to climb toward, so there is no boundary to
    // divide by — the card prints "infinite" for exactly this undefined.
    const progress = nextLevelFor(150000 * 1024)
    expect(progress?.currentKb).toBe(150000)
    expect(progress?.nextBoundaryKb).toBeUndefined()
  })

  it('draws no fill once a mine has run past its ceiling', () => {
    expect(nextLevelFor(150000 * 1024)?.ratio).toBe(0)
  })

  it('reads a full bar, not an error, when KB-rounding lands cur on a boundary it has not technically reached', () => {
    // 357_990 bytes is 349.60...KB — still short of the 350KB copper cut — but
    // rounds up to a displayed 350. This is the one case the [0,1] clamp
    // guards: cur can equal nextBoundaryKb through rounding alone, and this
    // pins that it reads as a full bar (ratio 1) rather than anything past it.
    // The clamp itself stays unproven by this suite — cur is derived from the
    // SAME bracket boundary as nextBoundaryKb, so it can reach but never
    // mathematically exceed it under the current formula; the clamp is
    // defensive against a future change to that formula, not load-bearing today.
    const weightBytes = Math.round(349.6 * 1024)
    const progress = nextLevelFor(weightBytes)
    expect(progress).toEqual({ currentKb: 350, nextBoundaryKb: 350, ratio: 1 })
  })
})

/**
 * The third acceptance run's fourth correction (#165).
 *
 * The maintainer declared a folder and its card sat bare for the seconds — and
 * on a big tree, minutes — the tier walk took: no tier, no entrance, no bar,
 * nothing. Every one of those absences was correct on its own (#41 forbids
 * claiming a tier nobody has measured), but together they read as a broken
 * card rather than as a mine being measured. The card says which it is.
 */
describe('isMeasuring', () => {
  it('says a declared project with nothing measured is being measured', () => {
    expect(isMeasuring(project({ declared: true }))).toBe(true)
  })

  // AMENDED for #635 (PANEL-QUESTIONS 29, design lead ruling 2026-09-27). This said a stored
  // verdict alone ends the measuring, which drew a mine measured in an earlier run as active with
  // no reading beside its tier while this run's walk was still owed. A stored tier with no weight
  // is exactly that re-measure: the mine keeps the tier and shows Measuring… (the next test).
  it('stops the moment this run’s walk gives the store’s verdict a weight', () => {
    expect(isMeasuring(project({ declared: true, knownTier: 'silver', weightBytes: 1 }))).toBe(
      false
    )
  })

  // APPENDED for #635 (PANEL-QUESTIONS 29): a stale reading still counts as known (#41), so this
  // is measuring WITH a tier, never a mine that lost it.
  it('says a declared mine measured before is being re-measured until its weight is read', () => {
    const again = project({ declared: true, knownTier: 'silver' })
    expect(isMeasuring(again)).toBe(true)
    expect(cardTierFor(again)).toBe('silver')
  })

  it('stops on a weight alone, which is a measurement the card can already read', () => {
    expect(isMeasuring(project({ declared: true, weightBytes: 4 * 1024 }))).toBe(false)
  })

  it('claims nothing about a project the user never declared', () => {
    // A discovered row has no walk promised to it, so an unmeasured one is not
    // a measurement in progress — it is a project nobody has looked at.
    expect(isMeasuring(project())).toBe(false)
  })

  // AMENDED for #635 (PANEL-QUESTIONS 29). This pinned the state to exactly the rows cardTierFor
  // has nothing to say about, the rule the ruling retires: a re-measured mine is measuring and
  // states its tier. What still holds is the other direction, kept here: a declared mine with no
  // tier to state is always measuring, so no card is left bare with neither.
  it('never leaves a declared mine with no tier to state outside Measuring', () => {
    for (const summary of [
      project({ declared: true }),
      project({ declared: true, knownTier: 'gold' }),
      project({ declared: true, weightBytes: 0 })
    ]) {
      if (cardTierFor(summary) === undefined) expect(isMeasuring(summary)).toBe(true)
    }
    expect(isMeasuring(project({ declared: true, weightBytes: 0 }))).toBe(false)
  })
})
