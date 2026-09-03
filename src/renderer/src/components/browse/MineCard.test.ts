// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultMaterials, defaultProject } from '../../testing/factories'
import MineCard from './MineCard.vue'
import cardSource from './MineCard.vue?raw'

describe('MineCard naming', () => {
  // AMENDED for #165: the maintainer reversed the "Cropper is confirmed and
  // deliberate" ruling on 2026-09-03. This read 'Cropper mine -'; it now
  // pins 'Copper mine -' instead.
  it('names the measured tier beside the project', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ knownTier: 'copper', name: 'Lalo-Test' }) }
    })
    expect(wrapper.get('.card-tier').text()).toBe('Copper mine -')
    expect(wrapper.get('.card-name').text()).toBe('Lalo-Test')
  })

  it('claims no tier for a project nobody has walked yet', () => {
    // Absence over invention (#41): an unmeasured project is shown as itself,
    // not as the bronze the map would provisionally draw it with.
    const wrapper = mount(MineCard, { props: { project: defaultProject({ name: 'fresh' }) } })
    expect(wrapper.find('.card-tier').exists()).toBe(false)
    expect(wrapper.get('.card-name').text()).toBe('fresh')
  })

  it('paints the entrance of the measured tier', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ knownTier: 'gold' }) }
    })
    expect(wrapper.get('.card-art').attributes('src')).toBeTruthy()
  })

  it('paints no entrance for an unmeasured project', () => {
    const wrapper = mount(MineCard, { props: { project: defaultProject() } })
    expect(wrapper.find('.card-art').exists()).toBe(false)
  })

  /*
   * #153's seventh correction, as the maintainer met it: a declared folder's
   * card showed the level bar and nothing else — no tier, no art — because the
   * bar joins from the tier walk's weight and the tier joined from a store field
   * only a WORKED mine fills. The card is one row again, and that is also the
   * bar alignment: the level column starts after the art, so a card missing its
   * art started its bar in a different place from every neighbour.
   */
  // AMENDED for #165: same reversal as above — 'Cropper mine -' pinned
  // 'Copper mine -' instead.
  it('states the tier its measured weight puts it in, art and all', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ name: 'Galactic-CV', weightBytes: 331 * 1024 }) }
    })
    expect(wrapper.get('.card-tier').text()).toBe('Copper mine -')
    expect(wrapper.get('.card-art').attributes('src')).toBeTruthy()
    expect(wrapper.find('.card-level').exists()).toBe(true)
    expect(wrapper.attributes('data-tier')).toBe('copper')
  })

  it('draws the same row whether the tier was recorded or derived', () => {
    const recorded = mount(MineCard, {
      props: { project: defaultProject({ knownTier: 'copper', weightBytes: 331 * 1024 }) }
    })
    const derived = mount(MineCard, {
      props: { project: defaultProject({ weightBytes: 331 * 1024 }) }
    })
    expect(derived.get('.card-art').attributes('src')).toBe(
      recorded.get('.card-art').attributes('src')
    )
    expect(derived.get('.card-tier').text()).toBe(recorded.get('.card-tier').text())
  })
})

/*
 * The mock's resource row (#135, #139). It is drawn through the vault's own
 * `vaultRows`/`formatUnits`/NUGGET_SRC, which is the point of these tests:
 * a card must not grow a second way to count or draw a material, so what is
 * pinned here is the rules that module already enforces showing up on a card.
 */
describe('MineCard resources', () => {
  it('draws one pill per material the vault holds, poorest first', () => {
    const wrapper = mount(MineCard, {
      props: {
        project: defaultProject({
          materials: defaultMaterials({ coal: 220_500_000, silver: 60_000_000 })
        })
      }
    })
    expect(
      wrapper.findAll('.card-resource').map((pill) => pill.attributes('data-material'))
    ).toEqual(['coal', 'silver'])
  })

  it('compacts the count the same way the vault chip does', () => {
    // 220_500_000 coal at 2_500 tokens a nugget is 88_200 nuggets — "88.2K".
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ materials: defaultMaterials({ coal: 220_500_000 }) }) }
    })
    expect(wrapper.get('.card-resource .resource-count').text()).toBe('88.2K')
  })

  it('carries the painted nugget of that material', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ materials: defaultMaterials({ gold: 500_000 }) }) }
    })
    expect(wrapper.get('.card-resource img').attributes('src')).toBeTruthy()
  })

  it('draws no pill for a material short of one whole nugget', () => {
    // The vault's rule (#22): a labelled row with nothing in it claims a pile
    // that is not there. Half a nugget of gold is not a pile.
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ materials: defaultMaterials({ gold: 50_000 }) }) }
    })
    expect(wrapper.findAll('.card-resource')).toHaveLength(0)
  })

  it('draws no resource row at all for a project the ledger has no row for', () => {
    // Absent materials is "never mined", not "mined zero" (#139) — and a row
    // of zeros would be the invention this card refuses everywhere else.
    const wrapper = mount(MineCard, { props: { project: defaultProject() } })
    expect(wrapper.find('.card-resources').exists()).toBe(false)
  })

  it('draws no resource row when the ledger row is empty', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ materials: defaultMaterials() }) }
    })
    expect(wrapper.find('.card-resources').exists()).toBe(false)
  })

  it('names the ore in words for anyone who cannot see the painting', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ materials: defaultMaterials({ coal: 220_500_000 }) }) }
    })
    expect(wrapper.get('.card-resource').attributes('title')).toContain('Coal')
  })
})

describe('MineCard crew', () => {
  /*
   * AMENDED for #135: the three crew tests below asserted 'Active agents'.
   * The mock capitalizes it — `Active Agents: 0` — and the maintainer ruled
   * the mock is the visual truth for this panel, so the copy follows the mock
   * and disagrees with the lowercase 'Active agents' in components.md and
   * screens/browse.md. Nothing else about these tests moved.
   */
  it('states the crew working the mine right now', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), activeAgents: 3 }
    })
    expect(wrapper.get('.card-agents').text()).toBe('Active Agents: 3')
  })

  it('states an empty crew, which the board can back', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), activeAgents: 0 }
    })
    expect(wrapper.get('.card-agents').text()).toBe('Active Agents: 0')
  })

  it('says nothing about the crew of a project nobody is working', () => {
    const wrapper = mount(MineCard, { props: { project: defaultProject({ live: false }) } })
    expect(wrapper.find('.card-agents').exists()).toBe(false)
  })
})

/*
 * The lower-right markers the mock draws (#135). The card is thin here on
 * purpose: what a marker MEANS is cardStatusFor's, tested beside it, and what
 * is pinned below is only that a fact the card was not given draws nothing.
 */
describe('MineCard status markers', () => {
  it('raises the message glyph for a crew that is asking something', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), status: { asking: true, resting: false } }
    })
    expect(wrapper.find('.status-asking').exists()).toBe(true)
    expect(wrapper.find('.status-resting').exists()).toBe(false)
  })

  it('raises the sleep glyph for a resting crew', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), status: { asking: false, resting: true } }
    })
    expect(wrapper.find('.status-resting').exists()).toBe(true)
    expect(wrapper.find('.status-asking').exists()).toBe(false)
  })

  it('raises both when both are true', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), status: { asking: true, resting: true } }
    })
    expect(wrapper.find('.status-asking').exists()).toBe(true)
    expect(wrapper.find('.status-resting').exists()).toBe(true)
  })

  it('draws no marker row for a crew that is simply working', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), status: { asking: false, resting: false } }
    })
    expect(wrapper.find('.card-status').exists()).toBe(false)
  })

  it('draws no marker row when the panel could back no fact at all', () => {
    // Absent status is the board having nothing to say about this project;
    // two quiet corners would be a claim rather than a silence.
    const wrapper = mount(MineCard, { props: { project: defaultProject() } })
    expect(wrapper.find('.card-status').exists()).toBe(false)
  })

  it('names each marker in words rather than leaving a bare glyph', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ live: true }), status: { asking: true, resting: true } }
    })
    expect(wrapper.get('.status-asking').attributes('title')).toBeTruthy()
    expect(wrapper.get('.status-resting').attributes('title')).toBeTruthy()
  })
})

/*
 * The seam #135's rebuild left, closed now that ProjectSummary carries
 * weightBytes (#140, #90). What cur/max/ratio mean is nextLevelFor's own
 * contract (browseCards.test.ts); the card's job is only drawing it.
 */
describe('MineCard level bar', () => {
  it('draws the bar and label once a walk has weighed the project', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ weightBytes: 80 * 1024 }) }
    })
    expect(wrapper.find('.card-level').exists()).toBe(true)
    expect(wrapper.get('.level-label-text').text()).toBe('Next level:')
    expect(wrapper.get('.level-label-value').text()).toBe('80/100')
  })

  it('sizes the fill to the bracket ratio', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ weightBytes: 235 * 1024 }) }
    })
    expect(wrapper.get('.level-fill').attributes('style')).toContain(`width: ${(235 / 500) * 100}%`)
  })

  it('prints infinite for a mine with no further tier to climb toward', () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ weightBytes: 10975 * 1024 }) }
    })
    expect(wrapper.get('.level-label-value').text()).toBe('10975/infinite')
  })

  it('draws no bar and no label for a project no walk has weighed yet', () => {
    // Absence over invention (#90): an invented denominator would be worse
    // than the silence every other unmeasured field on this card already is.
    const wrapper = mount(MineCard, { props: { project: defaultProject() } })
    expect(wrapper.find('.card-level').exists()).toBe(false)
  })
})

describe('MineCard action', () => {
  it('opens the mine of a live project', async () => {
    const wrapper = mount(MineCard, {
      props: { project: defaultProject({ id: 'C:/dev/alpha', live: true }), activeAgents: 1 }
    })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['C:/dev/alpha']])
  })

  it('offers no click affordance for a project with no mine to enter', () => {
    // The empty-mine interior is not built yet; a button that opened nothing
    // would be a dead affordance pretending to work.
    const wrapper = mount(MineCard, { props: { project: defaultProject({ live: false }) } })
    expect(wrapper.find('button').exists()).toBe(false)
  })
})

/*
 * ONE POSITION FOR THE LEVEL COLUMN, ON EVERY CARD (#156).
 *
 * Measured in a real build before this was written, over four cards: the level
 * column started 348px, 339px and 634px from the left edge of its own card, and
 * was absent from the fourth. The row was a flex line, so the column began
 * wherever the text column happened to stop — and the text column's width is
 * whatever its longest line needs, which moves with a missing painting, a
 * missing resources capsule and the length of the project's name.
 *
 * Its vertical offset moved with it, 49px against 43px, for a consequence of
 * the same cause: squeezed narrow, the `Next level: 12/500` label wrapped onto
 * two lines, the column grew taller, and being vertically centred it therefore
 * started higher.
 *
 * So the row is a GRID with three declared tracks and every child placed in one
 * by name. A card with no painting leaves that track empty rather than sliding
 * the rest of the row into it, and a card nobody has walked leaves the level
 * track empty rather than closing it up.
 *
 * Asserted against the stylesheet, because jsdom lays nothing out; the numbers
 * above were re-measured in a real build afterwards and came back identical on
 * all four cards.
 */
describe('MineCard level column placement', () => {
  function styleRule(selector: string): string {
    const at = cardSource.indexOf('\n' + selector + ' {')
    if (at === -1) throw new Error(`no ${selector} rule in MineCard.vue`)
    const open = cardSource.indexOf('{', at)
    const close = cardSource.indexOf('}', open)
    return cardSource.slice(open + 1, close)
  }

  it('lays the row out as declared tracks rather than as a flex line', () => {
    const body = styleRule('.card-body')
    expect(body).toMatch(/display:\s*grid/)
    expect(body).toMatch(/grid-template-columns:/)
  })

  it('gives the painting, the text and the level a track each, by name', () => {
    // The whole correction: without an explicit column, a card with no painting
    // slides its text into the painting's track and everything after it moves.
    expect(styleRule('.card-art')).toMatch(/grid-column:\s*1/)
    expect(styleRule('.card-text')).toMatch(/grid-column:\s*2/)
    expect(styleRule('.card-level')).toMatch(/grid-column:\s*3/)
  })

  it('never lets the level label wrap, so the column is one height everywhere', () => {
    // A wrapped label is a taller column, and a taller column centred in a
    // fixed-height card starts higher than its neighbours.
    expect(styleRule('.level-label')).toMatch(/white-space:\s*nowrap/)
  })

  it('keeps the level column out of the flex sizing it used to depend on', () => {
    expect(styleRule('.card-level')).not.toMatch(/flex:\s*1/)
  })
})
