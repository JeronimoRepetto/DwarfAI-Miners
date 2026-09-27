// @vitest-environment jsdom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INTERIOR_ART_SIZE, INTERIOR_SRC } from '../../lib/art'
import type { CrewSoundEvent } from '../../lib/audio/crew'
import { MINE_FOOTER_ORE_MAX } from '../../lib/scene/mineColumn'
import { MINE_COLUMN_CHROME_HEIGHT, MINE_COLUMN_MIN_WIDTH } from '../../lib/scene/sceneSizing'
import { defaultDwarf, defaultMaterials, defaultMine } from '../../testing/factories'
import { MATERIAL_TOKENS_PER_UNIT, type Mine, type MineTier } from '../../types'
import { assignScene } from '../../lib/scene/sceneAssignment'
import { sceneLayout } from '../../lib/scene/sceneLayout'
import MineColumn from './MineColumn.vue'
import SceneDwarf from './SceneDwarf.vue'

// Every mounted wrapper is unmounted after its test, so no walk leg, fade or timer it started
// outlives the page a later test tears down (#635: CI caught one updating a removed column).
enableAutoUnmount(afterEach)

/*
 * The mine column (#635), `organisms/mine-column` in the design, which replaces MineScene inside
 * PanelFrame. Where each of MineScene.test.ts's guarantees went, stated as test-safety asks:
 *
 * - vault, "gives every material this mine has produced its own entry, poorest first": here
 *   ("its footer's ore strip ..."). "shows the vault chip with tokensObserved", "asks the vault for
 *   its own bottom-edge strip" and "keeps the strip inside the interior": RETIRED by the design,
 *   whose ore strip is a footer plate below the art, per material, with no token total on it.
 * - arrivals ("places the crew already working", "walks in a later dwarf", "walks in the first
 *   dwarf to reach an empty mine", "starts it at a spawn point", "leaves an arrival in place under
 *   reduced motion"): the walk is RETIRED by the design (lib/scene/mineColumn.ts); an arrival fades
 *   in at its station ("fades in a dwarf that arrived after the column opened", below, and
 *   SceneDwarf.test.ts), and reduced motion zeroes --dur-panel (design-tokens.css).
 * - bubbles ("pauses the bubble auto-hide while expanded", "gives bubbles sharing an anchor
 *   distinct positions", "leaves a lone bubble where it sits"): RETIRED by the design, which floats
 *   only a dwarf's "?" over it; what a dwarf said is the MessagePanel's.
 * - as a place ("stands every dwarf on its own spot", "leaves a waiting dwarf where it was
 *   working", "keeps every dwarf inside", "gives the same crew the
 *   same spots on every poll"): here and in lib/scene/mineColumn.test.ts. "sends a leaving dwarf
 *   to a spawn point": REPLACED, a leaving dwarf keeps its station, idle. "paints the
 *   crew high to low": REPLACED by the design's crew order at one z-index.
 * - reduced motion ("marks the floor still", "animates the walks"): RETIRED with the walk.
 * - sprite scaling (four tests): RETIRED, the design draws every dwarf at 1x (36 x 38).
 * - interior shell: the painting per tier and the placeholder tier's own painting, here; "fits the
 *   painting without cropping" is the art box at the painting's aspect, here. Close, History, Add
 *   and the ambience toggle: here, on the toolbar plate and the footer. "draws Close, History and
 *   Add at the same size": the toolbar's three are the one small icon button (ActionButton);
 *   + Dwarf is the column's one large primary. The mute's "crossed-out glyph" and its pressed
 *   state are AMENDED: the design's toggle is pressed while the ambience is ON, and shows
 *   ambience-off once muted. "keeps the mine name as the section's accessible name, with no header
 *   on screen": AMENDED, the design names the region "Mine <name>" and shows the name on the plate.
 * - selection and single selection (six tests): here.
 * - crew sounds (three tests): here.
 *
 * DwarfSprite.test.ts went with DwarfSprite. Its sequence, selection, mark, tooltip and crew-sound
 * guarantees are in SceneDwarf.test.ts; its frame cycling and reduced-motion timing are the frame
 * clock's (lib/sprite/frameClock.test.ts, SpriteStrip.test.ts). RETIRED by the design with the
 * parts they tested: the talk glyph and its expanded message, the status icons (the "?" and the
 * "z" replace them), bubble stacking, the red halo tint, the walk and its arrival gate, the
 * departure walk, pick sparks, the strike glow and its side, per-depth sizing, and the
 * "activating" dim nothing fed since #162.
 *
 * Went with them, whole, their subjects retired by the same design: lib/overlay/bubbles.test.ts
 * (the talk bubble's board, its time-to-live and its hold) and lib/overlay/bubbleLayout.test.ts
 * (stacking bubbles that share a station), since nothing floats over a dwarf but its "?"; and
 * VaultChip.test.ts (the vault chip on the interior's bottom edge, its token total and its
 * per-material piles), whose place is the footer's vault strip (VaultStrip.test.ts, and "shows
 * the mine's ore in its footer strip" above). DwarfTooltip.test.ts's guarantees are listed in
 * DwarfTip.test.ts.
 */

afterEach(() => {
  document.body.innerHTML = ''
})

const mountColumn = (props: { mine: Mine } & Record<string, unknown>) =>
  mount(MineColumn, { props, attachTo: document.body })

describe('MineColumn', () => {
  it('is a region named "Mine <name>", the tier and name on its toolbar plate', () => {
    const wrapper = mountColumn({ mine: defaultMine({ name: 'DwarfAI-Miners', tier: 'silver' }) })
    const section = wrapper.find('section.dm-minecol')
    expect(section.attributes('aria-label')).toBe('Mine DwarfAI-Miners')
    const bar = wrapper.find('header.dm-minecol__bar')
    expect(bar.find('.dm-tier').attributes('data-tier')).toBe('silver')
    expect(bar.find('h2.dm-minecol__name').text()).toBe('DwarfAI-Miners')
    expect(bar.find('h2.dm-minecol__name').attributes('title')).toBe('DwarfAI-Miners')
  })

  describe('its toolbar and footer', () => {
    it('closes the mine, never the window', async () => {
      const wrapper = mountColumn({ mine: defaultMine() })
      await wrapper.find('button[aria-label="Close mine"]').trigger('click')
      expect(wrapper.emitted('close')).toHaveLength(1)
    })

    it('opens the mine history', async () => {
      const wrapper = mountColumn({ mine: defaultMine() })
      await wrapper.find('button[aria-label="Mine history"]').trigger('click')
      expect(wrapper.emitted('history')).toHaveLength(1)
    })

    it('asks for a dwarf from its one primary button, + Dwarf', async () => {
      const wrapper = mountColumn({ mine: defaultMine() })
      const add = wrapper.find('footer.dm-minecol__foot button.dm-btn--primary')
      expect(add.text()).toBe('+ Dwarf')
      expect(add.classes()).toEqual(expect.arrayContaining(['dm-btn--lg', 'dm-btn--block']))
      await add.trigger('click')
      expect(wrapper.emitted('add')).toHaveLength(1)
    })

    /*
     * The ambience toggle (#173): one accessible name whichever state, the state on aria-pressed,
     * pressed while the ambience plays (the design's toggle), and the verdict never the wish: it
     * paints what the audio engine above says, and only reports the press.
     */
    it('toggles the mine ambience, pressed while it plays', async () => {
      const wrapper = mountColumn({ mine: defaultMine(), ambienceMuted: false })
      const toggle = wrapper.find('button[aria-label="Mine ambience"]')
      expect(toggle.attributes('aria-pressed')).toBe('true')
      expect(toggle.attributes('title')).toBe('Mine ambience')
      await toggle.trigger('click')
      expect(wrapper.emitted('toggle-ambience-mute')).toHaveLength(1)
      expect(toggle.attributes('aria-pressed')).toBe('true')
      await wrapper.setProps({ ambienceMuted: true })
      expect(wrapper.find('button[aria-label="Mine ambience"]').attributes('aria-pressed')).toBe(
        'false'
      )
    })

    it('says the ambience plays when nothing tells it otherwise, the run’s own default', () => {
      const wrapper = mountColumn({ mine: defaultMine() })
      expect(wrapper.find('section').attributes('data-ambience')).toBe('on')
    })

    // Materials never convert into one another: each its own capsule, in its own units.
    it('shows the mine’s ore in its footer strip, every material its own entry, poorest first', () => {
      const wrapper = mountColumn({
        mine: defaultMine({
          materials: defaultMaterials({
            silver: 4 * MATERIAL_TOKENS_PER_UNIT.silver,
            coal: 548 * MATERIAL_TOKENS_PER_UNIT.coal,
            bronze: 90 * MATERIAL_TOKENS_PER_UNIT.bronze
          })
        })
      })
      const strip = wrapper.find('footer .dm-vault')
      expect(strip.attributes('aria-label')).toBe('Ore')
      expect(strip.find('.dm-vault__label').text()).toBe('Ore')
      expect(strip.findAll('.dm-ore').map((ore) => ore.attributes('aria-label'))).toEqual([
        'Coal: 548',
        'Bronze: 90',
        'Silver: 4'
      ])
    })
  })

  /*
   * The footer strip keeps the mine's four richest materials, by grain and never by a sum
   * (components.md, Vault strip: the column passes max 4), so a mine with all six fits its 300px.
   */
  describe('its footer ore', () => {
    it('keeps the four richest materials, poorest of them first', () => {
      const wrapper = mountColumn({
        mine: defaultMine({
          materials: defaultMaterials({
            coal: 1204 * MATERIAL_TOKENS_PER_UNIT.coal,
            bronze: 210 * MATERIAL_TOKENS_PER_UNIT.bronze,
            copper: 66 * MATERIAL_TOKENS_PER_UNIT.copper,
            silver: 18 * MATERIAL_TOKENS_PER_UNIT.silver,
            gold: 3 * MATERIAL_TOKENS_PER_UNIT.gold
          })
        })
      })
      expect(wrapper.findAll('footer .dm-ore').map((ore) => ore.attributes('aria-label'))).toEqual([
        'Bronze: 210',
        'Copper: 66',
        'Silver: 18',
        'Gold: 3'
      ])
      expect(MINE_FOOTER_ORE_MAX).toBe(4)
    })
  })

  describe('its art', () => {
    const TIERS: MineTier[] = ['bronze', 'copper', 'silver', 'gold', 'uranium']

    it('draws the production painting for the tier it is handed, labelled "<name> interior"', () => {
      for (const tier of TIERS) {
        const wrapper = mountColumn({ mine: defaultMine({ tier, name: 'AI-Tools' }) })
        const art = wrapper.find('.dm-minecol__art')
        expect(art.attributes('role')).toBe('img')
        expect(art.attributes('aria-label')).toBe('AI-Tools interior')
        expect(art.attributes('style')).toContain(INTERIOR_SRC[tier])
        wrapper.unmount()
      }
    })

    // The placeholder tier is for drawing (tierOf), so an unmeasured mine is still painted.
    it('gives an unmeasured mine the placeholder tier’s own painting rather than nothing', () => {
      const wrapper = mountColumn({ mine: defaultMine({ tier: 'bronze' }) })
      expect(wrapper.find('.dm-minecol__art').attributes('style')).toContain(INTERIOR_SRC.bronze)
    })

    /*
     * The whole painting at its own aspect, never cropped (the coordinates rule), from the same
     * numbers main reserves the column with: the column is the art's width plus 16px, never under
     * 300px, the art the shell's height less the chrome.
     */
    it('draws the art at the painting’s own aspect, sized from the constants main reserves with', () => {
      const wrapper = mountColumn({ mine: defaultMine() })
      const style = wrapper.find('section.dm-minecol').attributes('style') ?? ''
      expect(style).toContain(
        `--interior-aspect: ${INTERIOR_ART_SIZE.width} / ${INTERIOR_ART_SIZE.height}`
      )
      expect(style).toContain(`--chrome-h: ${MINE_COLUMN_CHROME_HEIGHT}px`)
      expect(style).toContain(`--minecol-min: ${MINE_COLUMN_MIN_WIDTH}px`)
    })

    it('draws nothing on the art but the dwarfs', () => {
      const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [defaultDwarf()] }) })
      const art = wrapper.find('.dm-minecol__art')
      expect(art.findAll(':scope > *').every((child) => child.classes().includes('dm-dwarf'))).toBe(
        true
      )
    })
  })

  describe('its crew', () => {
    const crew = [
      defaultDwarf({ id: 'a', name: 'One', status: 'working' }),
      defaultDwarf({ id: 'b', name: 'Two', role: 'foreman', status: 'waiting' }),
      defaultDwarf({ id: 'c', name: 'Three', role: 'worker2', status: 'working' })
    ]

    it('stands every dwarf on its own station, each a button', () => {
      const wrapper = mountColumn({ mine: defaultMine({ tier: 'silver', dwarfs: crew }) })
      const dwarfs = wrapper.findAll('.dm-minecol__art button.dm-dwarf')
      expect(dwarfs).toHaveLength(3)
      const spots = dwarfs.map((d) => d.attributes('style'))
      expect(new Set(spots).size).toBe(3)
    })

    it('keeps every dwarf on the painting, never off its edge', () => {
      const wrapper = mountColumn({ mine: defaultMine({ tier: 'gold', dwarfs: crew }) })
      for (const dwarf of wrapper.findAllComponents(SceneDwarf)) {
        const { x, y } = dwarf.props()
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(100)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(100)
      }
    })

    it('gives the same crew the same stations on every poll, so nobody jumps', async () => {
      const wrapper = mountColumn({ mine: defaultMine({ dwarfs: crew }) })
      const before = wrapper.findAll('button.dm-dwarf').map((d) => d.attributes('style'))
      await wrapper.setProps({
        mine: defaultMine({ dwarfs: [...crew].reverse().map((d) => ({ ...d })) })
      })
      const after = wrapper.findAll('button.dm-dwarf').map((d) => d.attributes('style'))
      expect([...after].sort()).toEqual([...before].sort())
    })

    it('leaves a dwarf that stopped working standing where it was working', async () => {
      const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [crew[0]!] }) })
      const before = wrapper.find('button.dm-dwarf').attributes('style')
      await wrapper.setProps({
        mine: defaultMine({ dwarfs: [{ ...crew[0]!, status: 'waiting' }] })
      })
      expect(wrapper.find('button.dm-dwarf').attributes('style')).toBe(before)
    })

    // AMENDED for #635 (was: "paints the crew high to low"): the design's own order, see
    // lib/scene/mineColumn.test.ts.
    it('draws the crew in the board’s order, as the roster does', () => {
      const wrapper = mountColumn({ mine: defaultMine({ dwarfs: crew }) })
      expect(wrapper.findAll('button.dm-dwarf').map((d) => d.attributes('data-dwarf'))).toEqual([
        'a',
        'b',
        'c'
      ])
    })

    it('stands a dwarf on the station its caller names, as the design’s sample does', () => {
      const wrapper = mountColumn({
        mine: defaultMine({ dwarfs: [crew[0]!] }),
        stations: { a: { x: 61.83, y: 24.94, facesLeft: false } }
      })
      expect(wrapper.findComponent(SceneDwarf).props()).toMatchObject({
        x: 61.83,
        y: 24.94,
        facesLeft: false
      })
    })

    // AMENDED for #635 (PANEL-QUESTIONS 14; was: "fades in a dwarf that arrived after the column
    // opened"): an arrival walks in from the mine's spawn point, as today (arrivals, below).
    it('walks in a dwarf that arrived after the column opened, and no other', () => {
      const wrapper = mountColumn({ mine: defaultMine({ dwarfs: crew }), arrived: new Set(['c']) })
      const walking = wrapper
        .findAllComponents(SceneDwarf)
        .filter((d) => d.props('walking'))
        .map((d) => d.props('dwarf').id)
      expect(walking).toEqual(['c'])
    })

    it('lists the crew in its roster, in the order the board gives it', () => {
      const wrapper = mountColumn({ mine: defaultMine({ dwarfs: crew }) })
      expect(
        wrapper
          .findAll('.dm-minecol__roster button.dm-portrait')
          .map((p) => p.attributes('data-dwarf'))
      ).toEqual(['a', 'b', 'c'])
    })

    it('draws each dwarf’s own delivery mark', () => {
      const wrapper = mountColumn({
        mine: defaultMine({ dwarfs: crew }),
        sendStates: { b: { phase: 'delivered' } }
      })
      const marked = wrapper
        .findAll('button.dm-dwarf[data-mark]')
        .map((d) => d.attributes('data-dwarf'))
      expect(marked).toEqual(['b'])
    })
  })

  describe('selection', () => {
    const one = defaultDwarf({ id: 'claude:s1', name: 'One' })
    const two = defaultDwarf({ id: 'claude:s2', name: 'Two' })

    it('names the dwarf that was pressed, on the art or in the roster', async () => {
      const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [one, two] }) })
      await wrapper.find('button.dm-dwarf[data-dwarf="claude:s2"]').trigger('click')
      await wrapper.find('.dm-minecol__roster button[data-dwarf="claude:s1"]').trigger('click')
      expect(wrapper.emitted('select')).toEqual([[two], [one]])
    })

    it('marks the selected dwarf, on the art and in the roster, and no other', () => {
      const wrapper = mountColumn({
        mine: defaultMine({ dwarfs: [one, two] }),
        selectedId: 'claude:s2'
      })
      expect(
        wrapper
          .findAll('button.dm-dwarf[aria-pressed="true"]')
          .map((d) => d.attributes('data-dwarf'))
      ).toEqual(['claude:s2'])
      expect(
        wrapper
          .findAll('button.dm-portrait[aria-pressed="true"]')
          .map((d) => d.attributes('data-dwarf'))
      ).toEqual(['claude:s2'])
    })

    it('marks nobody when no chat is open', () => {
      const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [one, two] }), selectedId: null })
      expect(
        wrapper.findAll('[aria-pressed="true"]').filter((el) => !el.classes().includes('dm-btn'))
      ).toEqual([])
    })

    // One sprite per dwarf (#165), whichever sources listed it: the first listing wins.
    it('draws one dwarf and one portrait per dwarf even when the crew lists one twice', () => {
      const wrapper = mountColumn({
        mine: defaultMine({ dwarfs: [one, { ...one, name: 'Later' }, two] }),
        selectedId: one.id
      })
      expect(wrapper.findAll('button.dm-dwarf')).toHaveLength(2)
      expect(wrapper.findAll('button.dm-portrait')).toHaveLength(2)
      expect(wrapper.findAll('button.dm-dwarf[aria-pressed="true"]')).toHaveLength(1)
      expect(wrapper.find('button.dm-dwarf[data-dwarf="claude:s1"] .dm-dwarf__tag').text()).toBe(
        'One'
      )
    })
  })

  describe('crew sounds (#330)', () => {
    it('forwards a dwarf’s cue with the mine, the dwarf and its rank, whole', () => {
      const crew = [
        defaultDwarf({ id: 'a', role: 'worker', status: 'waiting' }),
        defaultDwarf({ id: 'b', role: 'worker2', status: 'waiting' })
      ]
      const wrapper = mountColumn({ mine: defaultMine({ id: 'mine-1', dwarfs: crew }) })
      const second = wrapper.findAllComponents(SceneDwarf).find((d) => d.props('dwarf').id === 'b')!
      second.vm.$emit('crew-sound', { cue: 'shift', ending: true, gain: 0.5 })
      const sent = wrapper.emitted('crew-sound') as CrewSoundEvent[][]
      expect(sent).toEqual([
        [{ cue: 'shift', ending: true, gain: 0.5, mineId: 'mine-1', dwarfId: 'b', role: 'worker2' }]
      ])
    })
  })
})

/*
 * The walk (#635, PANEL-QUESTIONS 14, PO ruling 2026-09-27): today's walk stays, from the mine's
 * spawn point along the painted corridors, at today's speed. RESTORED from MineScene.test.ts
 * (88ee3fc), each under its old name: "places the crew that was already working when the mine
 * opened", "walks in a dwarf that turns up in a later snapshot", "walks in the first dwarf to reach
 * a mine that was opened empty", "starts that dwarf at a spawn point rather than on its
 * workstation", "leaves an arrival in place for a viewer who asked for less movement", and from its
 * reduced-motion block "still places the crew in the cave, but marks the floor still" and "animates
 * the walks for everyone who did not ask it to stop", read off the dwarfs' own walk now.
 */
describe('MineColumn arrivals', () => {
  const first = defaultDwarf({ id: 'first', name: 'first', status: 'working' })
  const later = defaultDwarf({ id: 'later', name: 'later', status: 'working' })
  const dwarfOf = (wrapper: ReturnType<typeof mountColumn>, id: string) =>
    wrapper.findAllComponents(SceneDwarf).find((d) => d.props('dwarf').id === id)!

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('places the crew that was already working when the mine opened', async () => {
    const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [first] }) })
    await wrapper.vm.$nextTick()
    expect(dwarfOf(wrapper, 'first').props('walking')).toBe(false)
  })

  it('walks in a dwarf that turns up in a later snapshot', async () => {
    const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [first] }) })
    await wrapper.vm.$nextTick()
    await wrapper.setProps({ mine: defaultMine({ dwarfs: [first, later] }) })
    await wrapper.vm.$nextTick()
    expect(dwarfOf(wrapper, 'later').props('walking')).toBe(true)
    expect(dwarfOf(wrapper, 'later').props('walkMs')).toBeGreaterThan(0)
  })

  it('walks in the first dwarf to reach a mine that was opened empty', async () => {
    const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [] }) })
    await wrapper.vm.$nextTick()
    await wrapper.setProps({ mine: defaultMine({ dwarfs: [later] }) })
    await wrapper.vm.$nextTick()
    expect(dwarfOf(wrapper, 'later').props('walking')).toBe(true)
  })

  it('starts that dwarf at a spawn point rather than on its workstation', async () => {
    const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [] }) })
    await wrapper.vm.$nextTick()
    await wrapper.setProps({ mine: defaultMine({ dwarfs: [later] }) })
    await wrapper.vm.$nextTick()
    const target = assignScene([later], sceneLayout('bronze')).get(later.id)!
    const at = dwarfOf(wrapper, 'later').props()
    // Somewhere on its route rather than parked on the rock it is walking to.
    expect([at.x, at.y]).not.toEqual([target.point.x, target.point.y])
  })

  it('leaves an arrival in place for a viewer who asked for less movement', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true })
    })
    const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [first] }) })
    await wrapper.vm.$nextTick()
    await wrapper.setProps({ mine: defaultMine({ dwarfs: [first, later] }) })
    await wrapper.vm.$nextTick()
    expect(dwarfOf(wrapper, 'later').props('walking')).toBe(false)
    expect(dwarfOf(wrapper, 'later').props('walkMs')).toBe(0)
  })

  it('still places the crew in the cave, but marks the floor still', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true })
    })
    const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [first] }) })
    expect(wrapper.findAll('button.dm-dwarf')).toHaveLength(1)
    expect(wrapper.find('.dm-minecol__art').classes()).toContain('is-still')
  })

  it('animates the walks for everyone who did not ask it to stop', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false })
    })
    const wrapper = mountColumn({ mine: defaultMine({ dwarfs: [first] }) })
    expect(wrapper.find('.dm-minecol__art').classes()).not.toContain('is-still')
  })
})

/*
 * ADDED for #635: a column closed mid-walk takes every walk leg, footstep and fade with it. CI
 * caught a walk leg updating a column after its test had torn the page down; nothing the column,
 * its dwarfs, the walk board or the tooltip started may run once it is gone.
 */
describe('MineColumn closing mid-walk', () => {
  it('runs nothing after it is unmounted, mid-walk, mid-fade and mid-tooltip', async () => {
    vi.useFakeTimers()
    const errors: unknown[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => errors.push(args))
    try {
      const walker = defaultDwarf({ id: 'later', status: 'working' })
      const leaver = defaultDwarf({ id: 'leaver', status: 'leaving' })
      const wrapper = mount(MineColumn, {
        props: { mine: defaultMine({ dwarfs: [] }) },
        attachTo: document.body,
        global: { config: { errorHandler: (err) => void errors.push(err) } }
      })
      await wrapper.vm.$nextTick()
      await wrapper.setProps({ mine: defaultMine({ dwarfs: [walker, leaver] }) })
      await wrapper.vm.$nextTick()
      expect(wrapper.findAllComponents(SceneDwarf).some((d) => d.props('walking'))).toBe(true)
      // The pointer resting on a dwarf leaves its tooltip's delay pending too.
      await wrapper.find('button.dm-dwarf').trigger('pointerenter')
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      wrapper.unmount()
      // Closed means nothing left pending: a leg or a delay that merely runs out harmlessly still
      // holds the column's state alive past it.
      expect(vi.getTimerCount()).toBe(0)
      document.body.innerHTML = ''
      await vi.advanceTimersByTimeAsync(60_000)
      expect(errors).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})
