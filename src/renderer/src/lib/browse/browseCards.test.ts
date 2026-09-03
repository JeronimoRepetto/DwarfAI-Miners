import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import type { ProjectSummary } from '../../types'
import { MINE_TIERS } from '../../types'
import {
  TIER_CHIPS,
  activeAgentsFor,
  browseTierLabel,
  cardArtFor,
  cardStatusFor,
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
