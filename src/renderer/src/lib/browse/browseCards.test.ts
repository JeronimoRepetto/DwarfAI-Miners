import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import type { ProjectSummary } from '../../types'
import { MINE_TIERS } from '../../types'
import {
  TIER_CHIPS,
  activeAgentsFor,
  browseTierLabel,
  cardArtFor,
  cardTierLabel
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
  it("spells the copper tier 'Cropper', which is the confirmed product label", () => {
    expect(browseTierLabel('copper')).toBe('Cropper')
  })

  it('names every other tier as the design writes it', () => {
    expect(browseTierLabel('bronze')).toBe('Bronze')
    expect(browseTierLabel('silver')).toBe('Silver')
    expect(browseTierLabel('gold')).toBe('Gold')
    expect(browseTierLabel('uranium')).toBe('Uranium')
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
      'Cropper',
      'Silver',
      'Gold',
      'Uranium'
    ])
  })

  it('offers a chip for every tier a mine can be', () => {
    expect(TIER_CHIPS.slice(1).map((chip) => chip.tier)).toEqual([...MINE_TIERS])
  })
})

describe('cardTierLabel', () => {
  it('names the tier a walk has measured', () => {
    expect(cardTierLabel(project({ knownTier: 'gold' }))).toBe('Gold')
  })

  it('claims no tier for a project nobody has measured yet', () => {
    // tierOf()'s provisional bronze is for drawing a mound, never for stating
    // a fact on a card (#41): an unmeasured project reads as unmeasured.
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
