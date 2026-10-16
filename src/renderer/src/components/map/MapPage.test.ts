// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
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
import markerSource from './TierMarker.vue?raw'
import MineCard from '../browse/MineCard.vue'
import TierInfo from '../browse/TierInfo.vue'
import toastHostSource from '../overlay/ToastHost.vue?raw'
import { useMapTime } from '../../composables/useMapTime'
import { useToasts } from '../../composables/useToasts'
import { MINE_UNENTERABLE_REASON, mineRefusalToast } from '../../lib/browse/mineCard'
import { MAP_TIME_REFRESH_MS } from '../../lib/map/mapTime'
import { TOAST_MS } from '../../lib/overlay/toast'

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
 *   beside it is not on the redesigned plate; VaultChip went with the old mine interior (#635,
 *   PR4), whose footer is the same vault strip.
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
    // AMENDED for #635 (PANEL-QUESTIONS 11; was: 'Dwarfs working3'): two working dwarfs and one
    // that needs you, which is counted in its own row alone.
    expect([...card.querySelectorAll('.dm-tip__row')].map((row) => row.textContent)).toEqual([
      'Dwarfs working2',
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

  /*
   * A press dismisses the card until the pointer leaves (components.md, Tooltip card: it shows when
   * the pointer arrives or on keyboard focus, and is gone on press). Found in the live app (#654):
   * after a click the card came back about a second later under the resting pointer, when the
   * window gave the pressed marker its focus again, and stayed until the pointer left.
   */
  it('keeps a pressed marker’s card away while the pointer rests there, whatever refocuses it', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    await rest(wrapper, TIP_DELAY_MS)
    const marker = wrapper.get('.dm-marker')
    await marker.trigger('pointerdown')
    await marker.trigger('click')
    await marker.trigger('blur')
    await marker.trigger('focus')
    await marker.trigger('pointerenter')
    await vi.advanceTimersByTimeAsync(TIP_DELAY_MS * 4)
    await flushPromises()
    expect(tip()).toBeNull()
    wrapper.unmount()
  })

  it('shows the card again once the pointer has left and come back', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    const marker = wrapper.get('.dm-marker')
    await marker.trigger('pointerdown')
    await marker.trigger('click')
    await marker.trigger('pointerleave')
    await rest(wrapper, TIP_DELAY_MS)
    expect(tip()).not.toBeNull()
    wrapper.unmount()
  })

  // A mouse press opens the mine without giving the marker focus, so no keyboard ring shows.
  it('takes no focus from a mouse press, only from the keyboard', async () => {
    const wrapper = mount(MapPage, { props, attachTo: document.body })
    const marker = wrapper.get('.dm-marker').element as HTMLButtonElement
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    marker.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    marker.focus()
    expect(document.activeElement).toBe(marker)
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

/*
 * PANEL-QUESTIONS 6: a marker for a mine whose folder no longer exists opens nothing; the page
 * reports the press so the shell can say why, and its tooltip adds "Not enterable".
 */
describe('MapPage, a mine that cannot be entered', () => {
  const gone = defaultProject({ id: 'C:/dev/old', name: 'old', folderMissing: true })

  it('reports a press on its marker instead of opening it', async () => {
    const wrapper = mount(MapPage, { props: { ...base, mines: [], projects: [gone] } })
    await markerFor(wrapper, 'old').trigger('click')
    expect(wrapper.emitted('open')).toBeUndefined()
    expect(wrapper.emitted('refuse')).toEqual([['C:/dev/old']])
  })

  it('adds "Not enterable" to its tooltip', async () => {
    const wrapper = mount(MapPage, {
      props: { ...base, mines: [], projects: [gone] },
      attachTo: document.body
    })
    await markerFor(wrapper, 'old').trigger('focus')
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('.dm-tip')?.textContent).toContain('Not enterable')
  })
})

/*
 * ISSUE-256: the Map page against US-MAP-001 to US-MAP-007 and US-RES-007.AC03, with the pinned
 * design (d12d3fc: screens/map.md, organisms/map-page, atoms/marker, molecules/tooltip). Most of it
 * was built by the September 2026 redesign; these tests carry the story ids.
 */
describe('MapPage, ISSUE-256', () => {
  const tipEl = () => document.body.querySelector<HTMLElement>('[role="tooltip"]')
  const crewed = defaultMine({
    id: 'C:/dev/beta',
    name: 'beta',
    tier: 'uranium',
    dwarfs: [defaultDwarf({ id: 'a' }), asking]
  })

  it('[US-MAP-001.AC01, US-MAP-001.AC07, NFR-TIM-01] a marker’s tooltip opens after 300 ms of hover or at once on focus and closes when the pointer leaves or on Esc', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MapPage, {
      props: { ...base, mines: [crewed] },
      attachTo: document.body
    })
    const marker = wrapper.get('.dm-marker')
    // Hover: nothing at 299ms, the card at 300ms, the app's one tooltip delay.
    expect(TIP_DELAY_MS).toBe(300)
    await marker.trigger('pointerenter')
    await vi.advanceTimersByTimeAsync(TIP_DELAY_MS - 1)
    expect(tipEl()).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(tipEl()!.querySelector('.dm-tip__title')!.textContent).toBe('Uraniumbeta')
    expect(tipEl()!.querySelector('.dm-tip__row')!.textContent).toBe('Dwarfs working1')
    // The pointer leaving closes it.
    await marker.trigger('pointerleave')
    await flushPromises()
    expect(tipEl()).toBeNull()
    // Keyboard focus shows it at once, and Esc closes it.
    await marker.trigger('focus')
    await flushPromises()
    expect(tipEl()).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(tipEl()).toBeNull()
    wrapper.unmount()
  })

  it('[US-MAP-001.AC04] the page adds Measuring… to the tooltip of a mine being measured', async () => {
    const measuring = defaultProject({ id: 'C:/dev/new', name: 'new', declared: true })
    const wrapper = mount(MapPage, {
      props: { ...base, mines: [], projects: [measuring] },
      attachTo: document.body
    })
    await markerFor(wrapper, 'new').trigger('focus')
    await flushPromises()
    expect([...tipEl()!.querySelectorAll('.dm-tip__row')].map((row) => row.textContent)).toEqual([
      'Dwarfs working0',
      'Measuring…'
    ])
    wrapper.unmount()
  })

  it('[US-MAP-002.AC01, US-MAP-002.AC02, US-MAP-002.AC03] activating an enterable marker opens its mine and makes it the only pressed marker, and a mine opened elsewhere moves the pressed state', async () => {
    const wrapper = mount(MapPage, { props: base })
    const pressed = () =>
      wrapper
        .findAll('.dm-marker')
        .filter((m) => m.attributes('aria-pressed') === 'true')
        .map((m) => m.attributes('aria-label'))
    await markerFor(wrapper, 'alpha').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['C:/dev/alpha']])
    // The shell opens it in the mine column and hands the page the open mine.
    await wrapper.setProps({ openId: 'C:/dev/alpha' })
    expect(pressed()).toEqual(['alpha, Bronze'])
    await markerFor(wrapper, 'beta').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['C:/dev/alpha'], ['C:/dev/beta']])
    await wrapper.setProps({ openId: 'C:/dev/beta' })
    expect(pressed()).toEqual(['beta, Gold'])
    // A mine opened by some other means (the Mines page, Valle): the pressed state follows it.
    await wrapper.setProps({ openId: 'C:/dev/gamma' })
    expect(pressed()).toEqual(['gamma, Uranium'])
  })

  it('[US-MAP-002.AC04] markers are placed by image percent, so after a resize a click lands on the same mine', async () => {
    let resized: (() => void) | undefined
    const aspect = MAP_ART_SIZE.width / MAP_ART_SIZE.height
    let size = { width: 400, height: 400 / aspect }
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback
        }
        observe(): void {}
        disconnect(): void {}
      }
    )
    const placed = defaultMine({ id: 'p', name: 'p', mapSite: 42 })
    const point = MAP_SPAWN_POINTS.find((candidate) => candidate.id === 42)!
    const wrapper = mount(MapPage, { props: { ...base, mines: [placed] } })
    const art = wrapper.get('.dm-mappage__art').element as HTMLElement
    art.getBoundingClientRect = () => ({ ...size, x: 0, y: 0, left: 0, top: 0 }) as DOMRect
    resized?.()
    await wrapper.vm.$nextTick()
    const placedAt = () => {
      const style = markerFor(wrapper, 'p').attributes('style') ?? ''
      expect(style).not.toMatch(/px/)
      return {
        x: Number(/--x: ([\d.]+)%/.exec(style)![1]),
        y: Number(/--y: ([\d.]+)%/.exec(style)![1])
      }
    }
    const small = placedAt()
    size = { width: 900, height: 900 / aspect }
    resized?.()
    await wrapper.vm.$nextTick()
    const large = placedAt()
    for (const at of [small, large]) {
      expect(at.x).toBeCloseTo(point.x, 9)
      expect(at.y).toBeCloseTo(point.y, 9)
    }
    await markerFor(wrapper, 'p').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['p']])
    vi.unstubAllGlobals()
  })

  it('[US-MAP-002.AC05] hover and press without a completed click change only the gem’s look', async () => {
    const wrapper = mount(MapPage, { props: { ...base, openId: 'C:/dev/alpha' } })
    const beta = markerFor(wrapper, 'beta')
    await beta.trigger('pointerenter')
    await beta.trigger('pointerdown')
    await beta.trigger('mousedown')
    await beta.trigger('pointerleave')
    expect(wrapper.emitted('open')).toBeUndefined()
    expect(wrapper.emitted('refuse')).toBeUndefined()
    expect(markerFor(wrapper, 'alpha').attributes('aria-pressed')).toBe('true')
    expect(beta.attributes('aria-pressed')).toBeUndefined()
    // The look is the marker's own CSS on :hover and :active, on the gem alone.
    expect(markerSource).toContain('.dm-marker:hover .dm-marker__gem')
    expect(markerSource).toContain('.dm-marker:active .dm-marker__gem')
  })

  it('[US-MAP-002.AC08, US-MAP-003.AC04, US-MAP-003.AC05] a marker that cannot be entered opens nothing, and its toast closes on its own without covering the painting, the dwarfs or a composer', async () => {
    vi.useFakeTimers()
    const gone = defaultProject({ id: 'C:/dev/old', name: 'old', folderMissing: true })
    const wrapper = mount(MapPage, { props: { ...base, mines: [], projects: [gone] } })
    await markerFor(wrapper, 'old').trigger('click')
    expect(wrapper.emitted('open')).toBeUndefined()
    expect(wrapper.emitted('refuse')).toEqual([['C:/dev/old']])
    // What the shell raises for that refusal (App.vue refuseMine): "<name>: <reason>", warned.
    const { showToast, toasts } = useToasts()
    showToast(mineRefusalToast('old'), 'warning')
    expect(toasts.value.map((t) => t.text)).toEqual([
      'old: Folder not found. It was moved or deleted.'
    ])
    vi.advanceTimersByTime(TOAST_MS)
    expect(toasts.value).toEqual([])
    // The Map is unchanged: the marker is still there, and still not enterable.
    await markerFor(wrapper, 'old').trigger('click')
    expect(wrapper.emitted('refuse')).toHaveLength(2)
    expect(wrapper.emitted('open')).toBeUndefined()
    // The toast host stands in the page column, 56px from its bottom, and takes no pointer
    // (decision log, Toast position); the toast contract itself is ISSUE-263's.
    expect(toastHostSource).toMatch(
      /position: absolute;[\s\S]*bottom: 56px;[\s\S]*pointer-events: none;/
    )
    wrapper.unmount()
  })

  /*
   * Lead decision (ISSUE-256, accepted difference recorded in the PR): US-RES-007.AC03 says the
   * card of a mine whose folder went missing "renders identically" at rest, but the pinned design
   * draws the state `molecules/mine-card#not-enterable` with the "Not enterable" pill and its
   * reason (components.md, Mine card; mine-card.js). The design wins for the card, which keeps its
   * tier's art and chip; the marker is drawn exactly like any other of its tier, as both sources
   * agree (US-MAP-003.AC01).
   */
  it('[US-MAP-003.AC01, US-RES-007.AC03] at rest a marker that cannot be entered, and a card or marker whose folder went missing, look like any other of their tier', () => {
    const gone = defaultProject({ id: 'C:/dev/old', name: 'old', folderMissing: true })
    const fine = defaultProject({ id: 'C:/dev/new', name: 'new' })
    const wrapper = mount(MapPage, { props: { ...base, mines: [], projects: [gone, fine] } })
    const look = (name: string) => {
      const marker = markerFor(wrapper, name)
      const attributes = { ...marker.attributes() }
      delete attributes['aria-label']
      delete attributes.style
      return { classes: marker.classes(), attributes, inner: marker.element.innerHTML }
    }
    expect(look('old')).toEqual(look('new'))
    // The card follows the design's pinned not-enterable state: its pill and its reason.
    const card = (state: 'active' | 'unenterable') =>
      mount(MineCard, {
        props: {
          card: {
            id: 'm1',
            name: 'old',
            tier: 'bronze',
            measured: true,
            state,
            ore: [],
            crew: [{ text: 'No dwarfs' }],
            needs: false,
            needsCount: 0,
            enterable: state === 'active',
            removable: true,
            ...(state === 'unenterable' ? { reason: MINE_UNENTERABLE_REASON } : {})
          }
        }
      })
    const missing = card('unenterable')
    expect(missing.get('.dm-card__note').text()).toBe(
      'Not enterable Folder not found. It was moved or deleted.'
    )
    expect(missing.get('.dm-tier').attributes('data-tier')).toBe(
      card('active').get('.dm-tier').attributes('data-tier')
    )
  })

  it('[US-MAP-004.AC08] markers appear and disappear at once, with no animation', async () => {
    const wrapper = mount(MapPage, { props: { ...base, mines: [MINES[0]!] } })
    expect(wrapper.findAll('.dm-marker')).toHaveLength(1)
    await wrapper.setProps({ mines: MINES })
    expect(wrapper.findAll('.dm-marker')).toHaveLength(3)
    await wrapper.setProps({ mines: [MINES[2]!] })
    expect(wrapper.findAll('.dm-marker').map((m) => m.attributes('aria-label'))).toEqual([
      'gamma, Uranium'
    ])
    // No transition wraps the markers: the art box holds them bare.
    const template = pageSource.slice(pageSource.indexOf('<template>'))
    const art = template.slice(
      template.indexOf('class="dm-mappage__art"'),
      template.indexOf('</div>')
    )
    expect(art).toContain('<TierMarker')
    expect(art).not.toMatch(/Transition/)
  })

  it('[US-MAP-006.AC01, US-MAP-006.AC02, US-MAP-007.AC05] with no mine the painting is veiled, no marker is drawn, the ore totals read No ore yet, the card shows its text with Add a mine, and the legend with its info button stays', () => {
    const empty = mount(MapPage, { props: { ...base, mines: [] } })
    expect(empty.get('.dm-mappage__art').classes()).toContain('is-empty')
    expect(pageSource).toMatch(
      /\.dm-mappage__art\.is-empty::after \{[^}]*background: var\(--veil\)/
    )
    expect(empty.find('.dm-marker').exists()).toBe(false)
    expect(empty.get('.dm-mappage__totals .dm-vault__empty').text()).toBe('No ore yet')
    const card = empty.get('.dm-mappage__card')
    expect(card.get('.dm-mappage__say').text()).toBe('No mines yet. Add a project folder to start.')
    expect(card.get('button').text()).toBe('Add a mine')
    // The legend is exactly the populated Map's.
    const populated = mount(MapPage, { props: base })
    expect(empty.get('footer').html()).toBe(populated.get('footer').html())
    expect(empty.get('footer button').attributes('aria-label')).toBe('Tiers and ore')
  })

  it('[US-MAP-006.AC03, US-MAP-006.AC04, US-MAP-006.AC05, US-MAP-006.AC06] Add a mine opens the OS folder picker; a valid folder lifts the veil and card at once, a cancel changes nothing and the Add panel never opens', async () => {
    const wrapper = mount(MapPage, { props: { ...base, mines: [] } })
    const before = wrapper.html()
    await wrapper.get('.dm-mappage__card button').trigger('click')
    // The page asks the shell for the Mines page's own add flow (App.vue addMine, the same
    // handler the Mines page's "Add a mine" uses: main's declareMine shows the OS folder picker),
    // and asks for nothing else: no mine opened, no Add panel.
    expect(Object.keys(wrapper.emitted()).filter((name) => name !== 'click')).toEqual(['add'])
    expect(wrapper.emitted('add')).toEqual([[]])
    // While the picker is up the action is held; a cancel hands back the same empty map.
    await wrapper.setProps({ adding: true })
    await wrapper.setProps({ adding: false })
    expect(wrapper.html()).toBe(before)
    // A valid folder: the first mine arrives, and the veil and the card lift at once.
    await wrapper.setProps({ mines: [MINES[0]!] })
    expect(wrapper.get('.dm-mappage__art').classes()).not.toContain('is-empty')
    expect(wrapper.find('.dm-mappage__card').exists()).toBe(false)
    expect(wrapper.findAll('.dm-marker')).toHaveLength(1)
  })

  /*
   * Accepted difference (design wins, recorded in the PR): US-MAP-007.AC01 names the legend
   * "Tiers and ore". The pinned design names the legend plate "Legend", keeps the "?" needs-you
   * key after the tiers (map-page.js), and gives the name "Tiers and ore" to its info button.
   */
  it('[US-MAP-007.AC01, US-MAP-007.AC03] the legend shows the five tier chips then the info button and is named Tiers and ore', () => {
    const legend = mount(MapPage, { props: base }).get('footer')
    const keys = legend.findAll('.dm-mappage__key')
    expect(keys.slice(0, 5).map((key) => [key.text(), key.attributes('data-tier')])).toEqual([
      ['Bronze', 'bronze'],
      ['Copper', 'copper'],
      ['Silver', 'silver'],
      ['Gold', 'gold'],
      ['Uranium', 'uranium']
    ])
    // Each chip wears its tier's colour, the one the markers wear, so no modal is needed to read it.
    expect(keys.slice(0, 5).every((key) => key.find('.dm-hex').exists())).toBe(true)
    expect(pageSource).toMatch(/\.dm-mappage__key \.dm-hex \{[^}]*background: var\(--tier-c\)/)
    const last = legend.element.lastElementChild!
    expect(last.tagName).toBe('BUTTON')
    expect(last.getAttribute('aria-label')).toBe('Tiers and ore')
    expect(legend.attributes('aria-label')).toBe('Legend')
  })

  it('[US-MAP-007.AC02, US-MAP-007.AC04] the info button opens the same Tiers and ore modal and closing it returns focus to the Map’s own button', async () => {
    const wrapper = mount(MapPage, { props: base, attachTo: document.body })
    const info = wrapper.get('footer button').element as HTMLButtonElement
    info.focus()
    info.click()
    await flushPromises()
    const shown = document.body.querySelector('.dm-tinfo')!
    // The same explainer the Mines page shows: the one TierInfo, with no Map-specific props.
    expect(shown.innerHTML).toBe(mount(TierInfo).element.innerHTML)
    expect(document.activeElement).not.toBe(info)
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
    await flushPromises()
    expect(document.body.querySelector('.dm-tinfo')).toBeNull()
    expect(document.activeElement).toBe(info)
    wrapper.unmount()
  })

  it('[US-MAP-005.AC02, US-MAP-005.AC03] the once-a-minute re-read swaps the painting with no transition only when the range changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3, 11, 58, 30))
    const Host = defineComponent({
      setup() {
        const variant = useMapTime()
        return () => h(MapPage, { ...base, variant: variant.value })
      }
    })
    const wrapper = mount(Host)
    const art = () => wrapper.get('.dm-mappage__art')
    expect(art().attributes('data-variant')).toBe('morning')
    const first = art().attributes('style')
    // 11:59:30: re-read, same range, nothing visible changes.
    await vi.advanceTimersByTimeAsync(MAP_TIME_REFRESH_MS)
    expect(art().attributes('data-variant')).toBe('morning')
    expect(art().attributes('style')).toBe(first)
    // 12:00:30: the next re-read crosses into the day, and the painting swaps.
    await vi.advanceTimersByTimeAsync(MAP_TIME_REFRESH_MS)
    expect(art().attributes('data-variant')).toBe('day')
    expect(art().attributes('style')).toContain(MAP_BG_SRC.day)
    // With no transition between the two images: the art box animates nothing.
    const artRule = pageSource.slice(pageSource.indexOf('.dm-mappage__art {'))
    expect(artRule.slice(0, artRule.indexOf('}'))).not.toMatch(/transition|animation/)
    wrapper.unmount()
  })
})
