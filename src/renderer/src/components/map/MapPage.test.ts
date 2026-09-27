// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAP_ART_SIZE, MAP_BG_SRC } from '../../lib/art'
import { TIP_DELAY_MS } from '../../lib/overlay/tipCard'
import { MAP_SPAWN_POINTS } from '../../lib/map/spawnPoints.generated'
import {
  defaultDwarf,
  defaultMaterials,
  defaultMine,
  defaultProject
} from '../../testing/factories'
import { MATERIAL_TOKENS_PER_UNIT, type Dwarf } from '../../types'
import MapPage from './MapPage.vue'
import pageSource from './MapPage.vue?raw'

/*
 * The redesigned Map page (#635), organisms/map-page. It replaces MapView.vue (#136, #153, #197,
 * #506, #566), MineMarker.vue (#136, #156) and MaterialInfoModal.vue (#506), whose test files went
 * with them (MapView.test.ts 33, MineMarker.test.ts 11, MaterialInfoModal.test.ts 7), and so did
 * lib/map/mapTooltip.test.ts (9) with the tooltip box it worded and placed. Where each group's
 * guarantee lives now:
 * - a marker per mine, one for a live mine and its remembered project, a stand-in for every
 *   remembered project, opening a mine: here. The population rule is lib/map/mapPopulation.test.ts.
 * - the 74 spawn points, the remembered site, the deterministic fallback, never two on one point,
 *   stable across a refresh: lib/map/mapPage.test.ts ("mapMarkers"), and here for the style that
 *   places a marker. The one-layer-under-the-chip test went with its layer: the design stacks the
 *   markers at z-index 1 and 2 under the totals plate at 3 (map-page.css), which the page states.
 * - the frame's aspect ratio (#197): here, on `.dm-mappage__art`, which is the frame now.
 * - the marker itself (a named, keyboard-reachable button in its tier's colour; its pulse, and the
 *   steady halo under reduced motion): TierMarker.test.ts and the atoms/marker goldens. Its name
 *   is the design's "<name>, <Tier>[, needs you]" (lib/map/mapPage.test.ts), no longer
 *   "Enter <name> (<Tier> mine, <n> agents working)"; the crew count moved to its tooltip. The
 *   radial light and its 2.4s breath (#156) gave way to the design's stepped hexagon halo.
 * - the tooltip (300ms of continuous rest, nothing for a pointer passing over, gone on leave, at
 *   once on keyboard focus, one at a time, a pending one dropped on teardown): here. Its words are
 *   lib/map/mapPage.test.ts's ("mineTip": the crew said as zero rather than nothing, an unwalked
 *   mine's drawn tier; Copper spelled as the redesign spells it is TierChip's and "mapMarkerLabel"),
 *   its card TooltipCard.test.ts's, its placement (never leaving the window, flipping below a target
 *   too near the top, pinned to the near edge when too big) lib/overlay/tipCard.test.ts's. The
 *   design's 170x60 size and its above-right corner went with the old box: the card sizes to its
 *   content and sits above its target, centred (hoverTip's defaults).
 *   The 90% rest opacity and motion-v's fadeVariants (#566 T3) are not carried over: the card is
 *   opaque wood and rises 6px in, by motion.md's Overlays table.
 * - the time-of-day painting and its clock: composables/useMapTime.test.ts; here, that the page
 *   paints whichever variant it is handed.
 * - the vault (the whole ledger by material, an empty vault said rather than hidden): here, on the
 *   totals plate, and lib/map/mapPage.test.ts ("mapTotals"). The raw token total VaultChip showed
 *   beside it is not on the redesigned plate; VaultChip stays in the mine interior.
 * - material info (the info button, opening and closing the explainer): here, as "Tiers and ore",
 *   which opens the merged TierInfo (TierInfo.test.ts and lib/browse/tierInfo.test.ts have every
 *   material's grain in order, which MaterialInfoModal's two table tests pinned). Its Esc and its
 *   close button are ModalDialog's (ModalDialog.test.ts), and its accent-coloured title is the
 *   dialog card's; its motion-v pop and press variants are not carried over (#566), as on the
 *   Mines page.
 */

const MINES = [
  defaultMine({ id: 'C:/dev/alpha', name: 'alpha', tier: 'bronze' }),
  defaultMine({ id: 'C:/dev/beta', name: 'beta', tier: 'gold' }),
  defaultMine({ id: 'C:/dev/gamma', name: 'gamma', tier: 'uranium' })
]

const base = { mines: MINES, openId: null, variant: 'day' as const }

// Only the presence of a question is read, so its shape is left empty.
const asking: Dwarf = defaultDwarf({
  id: 'ask',
  status: 'waiting',
  pendingQuestion: {} as NonNullable<Dwarf['pendingQuestion']>
})

function markerFor(wrapper: ReturnType<typeof mount>, name: string) {
  const found = wrapper
    .findAll('.dm-marker')
    .find((marker) => marker.attributes('aria-label')?.startsWith(name + ','))
  if (found === undefined) throw new Error(`no marker for ${name}`)
  return found
}

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('MapPage', () => {
  it('is the region "Map" under its header, the painting a group named "Valley map"', () => {
    const wrapper = mount(MapPage, { props: base })
    expect(wrapper.get('section').attributes('aria-label')).toBe('Map')
    expect(wrapper.get('.dm-phead__title').text()).toBe('Map')
    expect(wrapper.get('.dm-mappage__art').attributes('role')).toBe('group')
    expect(wrapper.get('.dm-mappage__art').attributes('aria-label')).toBe('Valley map')
  })

  it('renders one marker per mine, each named for its mine and its tier', () => {
    const wrapper = mount(MapPage, { props: base })
    expect(wrapper.findAll('.dm-marker').map((m) => m.attributes('aria-label'))).toEqual([
      'alpha, Bronze',
      'beta, Gold',
      'gamma, Uranium'
    ])
  })

  it('draws a marker for a remembered project with no live session', () => {
    const wrapper = mount(MapPage, {
      props: { ...base, mines: [], projects: [defaultProject({ id: 'C:/dev/old', name: 'old' })] }
    })
    expect(wrapper.findAll('.dm-marker')).toHaveLength(1)
  })

  it('draws one marker, not two, for a live mine and its remembered project', () => {
    const wrapper = mount(MapPage, {
      props: { ...base, projects: [defaultProject({ id: 'C:/dev/alpha', name: 'alpha' })] }
    })
    expect(wrapper.findAll('.dm-marker')).toHaveLength(MINES.length)
  })

  it('emits open with the mine id when a marker is clicked', async () => {
    const wrapper = mount(MapPage, { props: base })
    await markerFor(wrapper, 'beta').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['C:/dev/beta']])
  })

  it('marks the open mine’s marker pressed', () => {
    const wrapper = mount(MapPage, { props: { ...base, openId: 'C:/dev/beta' } })
    expect(markerFor(wrapper, 'beta').attributes('aria-pressed')).toBe('true')
    expect(markerFor(wrapper, 'alpha').attributes('aria-pressed')).toBeUndefined()
  })

  it('draws the "?" marker for a mine whose dwarf needs you', () => {
    const mine = defaultMine({ id: 'q', name: 'q', tier: 'silver', dwarfs: [asking] })
    const wrapper = mount(MapPage, { props: { ...base, mines: [mine] } })
    const marker = markerFor(wrapper, 'q')
    expect(marker.classes()).toContain('dm-marker--ask')
    expect(marker.attributes('aria-label')).toBe('q, Silver, needs you')
  })

  it('stands a marker on its site in image percent, the point it centres itself on', () => {
    const placed = defaultMine({ id: 'p', name: 'p', mapSite: 42 })
    const point = MAP_SPAWN_POINTS.find((candidate) => candidate.id === 42)!
    const wrapper = mount(MapPage, { props: { ...base, mines: [placed] } })
    const style = markerFor(wrapper, 'p').attributes('style') ?? ''
    expect(style).toContain(`--x: ${point.x}%`)
    expect(style).toContain(`--y: ${point.y}%`)
  })

  /*
   * The art box carries the painting's own aspect (#197), which is what lets a site's image
   * percent be its box percent: a box of any other shape would slide a marker off its ledge.
   */
  it('gives the art box the painting’s own aspect ratio, inside the well that fits it', () => {
    const artRule = pageSource.slice(pageSource.indexOf('.dm-mappage__art {'))
    const body = artRule.slice(0, artRule.indexOf('}'))
    expect(body).toContain(`aspect-ratio: ${MAP_ART_SIZE.width} / ${MAP_ART_SIZE.height}`)
    expect(body).toContain('width: min(100cqw, 100cqh * 0.805556)')
  })

  it('paints the painting it is handed', () => {
    const wrapper = mount(MapPage, { props: { ...base, variant: 'night' } })
    const art = wrapper.get('.dm-mappage__art')
    expect(art.attributes('style')).toContain(MAP_BG_SRC.night)
    expect(art.attributes('data-variant')).toBe('night')
  })
})

describe('MapPage totals', () => {
  it('shows the whole vault by material, including ore no mine on screen produces', () => {
    const wrapper = mount(MapPage, {
      props: {
        ...base,
        materials: defaultMaterials({
          coal: 200 * MATERIAL_TOKENS_PER_UNIT.coal,
          bronze: 2 * MATERIAL_TOKENS_PER_UNIT.bronze
        })
      }
    })
    const plate = wrapper.get('.dm-mappage__totals [role="group"]')
    expect(plate.attributes('aria-label')).toBe('Ore')
    expect(plate.get('.dm-vault__label').text()).toBe('Ore')
    expect(plate.findAll('.dm-ore').map((o) => o.attributes('aria-label'))).toEqual([
      'Coal: 200',
      'Bronze: 2'
    ])
  })

  it('says "No ore yet" rather than nothing when no breakdown has arrived', () => {
    const wrapper = mount(MapPage, { props: base })
    expect(wrapper.get('.dm-mappage__totals .dm-vault__empty').text()).toBe('No ore yet')
  })
})

describe('MapPage first run', () => {
  const empty = { ...base, mines: [] }

  it('dims the whole painting, draws no marker, and centres one card with the one action', () => {
    const wrapper = mount(MapPage, { props: empty })
    expect(wrapper.get('.dm-mappage__art').classes()).toContain('is-empty')
    expect(wrapper.find('.dm-marker').exists()).toBe(false)
    const card = wrapper.get('.dm-mappage__card')
    expect(card.attributes('role')).toBe('status')
    expect(card.get('.dm-mappage__say').text()).toBe('No mines yet. Add a project folder to start.')
    expect(card.get('button').text()).toBe('Add a mine')
  })

  it('asks the host to add a mine, and never to launch a dwarf', async () => {
    const wrapper = mount(MapPage, { props: empty })
    await wrapper.get('.dm-mappage__card button').trigger('click')
    expect(wrapper.emitted('add')).toEqual([[]])
  })

  it('holds the action while main shows the folder picker', () => {
    const wrapper = mount(MapPage, { props: { ...empty, adding: true } })
    expect(wrapper.get('.dm-mappage__card button').attributes('disabled')).toBeDefined()
  })

  it('claims no emptiness while the mines are still being read', () => {
    const wrapper = mount(MapPage, { props: { ...empty, loading: true } })
    expect(wrapper.find('.dm-mappage__card').exists()).toBe(false)
    expect(wrapper.get('.dm-mappage__art').classes()).not.toContain('is-empty')
  })

  it('lifts the veil and the card once a mine is there', () => {
    const wrapper = mount(MapPage, { props: base })
    expect(wrapper.find('.dm-mappage__card').exists()).toBe(false)
    expect(wrapper.get('.dm-mappage__art').classes()).not.toContain('is-empty')
  })
})

describe('MapPage legend', () => {
  it('is a named group of the five tiers in canonical order, then the "?"', () => {
    const wrapper = mount(MapPage, { props: base })
    const legend = wrapper.get('footer')
    expect(legend.attributes('aria-label')).toBe('Legend')
    expect(legend.findAll('.dm-mappage__key').map((key) => key.text())).toEqual([
      'Bronze',
      'Copper',
      'Silver',
      'Gold',
      'Uranium',
      '?needs you'
    ])
  })

  it('opens the tier and ore explainer from its info button, and closes it', async () => {
    const wrapper = mount(MapPage, { props: base, attachTo: document.body })
    const info = wrapper.get('footer button')
    expect(info.attributes('aria-label')).toBe('Tiers and ore')
    await info.trigger('click')
    await flushPromises()
    expect(document.body.querySelector('.dm-tinfo')).not.toBeNull()
    document.body.querySelector<HTMLButtonElement>('.dm-dialog__actions button')!.click()
    await flushPromises()
    expect(document.body.querySelector('.dm-tinfo')).toBeNull()
    wrapper.unmount()
  })
})

describe('MapPage mine tooltip', () => {
  const crewed = defaultMine({
    id: 'C:/dev/beta',
    name: 'beta',
    tier: 'uranium',
    mapSite: 20,
    dwarfs: [defaultDwarf({ id: 'a' }), defaultDwarf({ id: 'b' }), asking]
  })
  const props = { ...base, mines: [crewed] }
  const tip = () => document.body.querySelector<HTMLElement>('[role="tooltip"]')

  async function rest(wrapper: ReturnType<typeof mount>, ms: number): Promise<void> {
    await wrapper.get('.dm-marker').trigger('pointerenter')
    await vi.advanceTimersByTimeAsync(ms)
    await flushPromises()
  }

  it('says nothing until the pointer has rested for the design’s 300ms', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    await rest(wrapper, TIP_DELAY_MS - 1)
    expect(tip()).toBeNull()
    wrapper.unmount()
  })

  it('shows the card once the pointer has rested that long: tier, name and its facts', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    await rest(wrapper, TIP_DELAY_MS)
    const card = tip()!
    expect(card.querySelector('.dm-tier')!.getAttribute('data-tier')).toBe('uranium')
    expect(card.querySelector('.dm-tip__title')!.textContent).toBe('Uraniumbeta')
    expect([...card.querySelectorAll('.dm-tip__row')].map((row) => row.textContent)).toEqual([
      'Dwarfs working3',
      'Needs you1'
    ])
    wrapper.unmount()
  })

  it('shows nothing for a pointer that only passes over the marker', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    await wrapper.get('.dm-marker').trigger('pointerenter')
    await vi.advanceTimersByTimeAsync(TIP_DELAY_MS / 2)
    await wrapper.get('.dm-marker').trigger('pointerleave')
    await vi.advanceTimersByTimeAsync(TIP_DELAY_MS)
    await flushPromises()
    expect(tip()).toBeNull()
    wrapper.unmount()
  })

  it('hides the card when the pointer leaves the marker', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    await rest(wrapper, TIP_DELAY_MS)
    await wrapper.get('.dm-marker').trigger('pointerleave')
    await flushPromises()
    expect(tip()).toBeNull()
    wrapper.unmount()
  })

  it('hides the card on a press, and a press never brings it back', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    await rest(wrapper, TIP_DELAY_MS)
    const marker = wrapper.get('.dm-marker')
    await marker.trigger('pointerdown')
    await marker.trigger('focus')
    await flushPromises()
    expect(tip()).toBeNull()
    wrapper.unmount()
  })

  it('lets keyboard focus show the card again after a press dragged off the marker', async () => {
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    const marker = wrapper.get('.dm-marker')
    await marker.trigger('pointerdown')
    await marker.trigger('pointerleave')
    await marker.trigger('focus')
    await flushPromises()
    expect(tip()).not.toBeNull()
    wrapper.unmount()
  })

  it('hides the card on Esc', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    await rest(wrapper, TIP_DELAY_MS)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(tip()).toBeNull()
    wrapper.unmount()
  })

  it('shows the card at once for a marker reached by keyboard, and hides it on blur', async () => {
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    await wrapper.get('.dm-marker').trigger('focus')
    await flushPromises()
    expect(tip()).not.toBeNull()
    await wrapper.get('.dm-marker').trigger('blur')
    await flushPromises()
    expect(tip()).toBeNull()
    wrapper.unmount()
  })

  it('shows one card at a time, whatever the pointer does', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, { props: base, attachTo: document.body })
    await markerFor(wrapper, 'alpha').trigger('pointerenter')
    await vi.advanceTimersByTimeAsync(TIP_DELAY_MS)
    await markerFor(wrapper, 'beta').trigger('pointerenter')
    await vi.advanceTimersByTimeAsync(TIP_DELAY_MS)
    await flushPromises()
    const cards = document.body.querySelectorAll('[role="tooltip"]')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.textContent).toContain('beta')
    wrapper.unmount()
  })

  it('drops a pending card when the page is torn down', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    await wrapper.get('.dm-marker').trigger('pointerenter')
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
