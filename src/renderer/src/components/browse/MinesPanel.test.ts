// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDwarf, defaultMine, defaultProject } from '../../testing/factories'
import MinesPanel from './MinesPanel.vue'

/**
 * jsdom ships no IntersectionObserver, and the infinite list is the one place
 * the panel depends on one. This fake records every observer so a test can fire
 * the sentinel by hand, and counts observe() calls because re-observing is how
 * the panel asks a real observer to redeliver the sentinel's current state.
 */
class FakeObserver {
  observed = 0
  disconnected = false
  constructor(public callback: IntersectionObserverCallback) {
    observers.push(this)
  }
  observe(): void {
    this.observed += 1
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true
  }
}

let observers: FakeObserver[] = []

beforeEach(() => {
  observers = []
  vi.stubGlobal('IntersectionObserver', FakeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function enterView(): void {
  for (const observer of observers) {
    observer.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      null as unknown as IntersectionObserver
    )
  }
}

/** The chip at that position, or a loud failure — noUncheckedIndexedAccess. */
function chipAt(wrapper: ReturnType<typeof panel>, index: number) {
  const chip = wrapper.findAll('.tier-chip').at(index)
  if (chip === undefined) throw new Error(`the panel drew no chip at ${index}`)
  return chip
}

/** The observer the panel opened for its sentinel, or a loud failure. */
function onlyObserver(): FakeObserver {
  const observer = observers.at(0)
  if (observer === undefined) throw new Error('the panel opened no observer')
  return observer
}

function panel(props: Record<string, unknown> = {}) {
  return mount(MinesPanel, {
    props: {
      projects: [],
      mines: [],
      search: '',
      tier: null,
      direction: 'desc',
      loading: false,
      error: null,
      exhausted: false,
      adding: false,
      addError: null,
      ...props
    }
  })
}

describe('MinesPanel chrome', () => {
  it('titles the panel Mines', () => {
    expect(panel().get('.panel-title').text()).toBe('Mines')
  })

  it('shows what is currently typed and reports every keystroke', async () => {
    const wrapper = panel({ search: 'lalo' })
    const field = wrapper.get('.search-field')
    expect((field.element as HTMLInputElement).value).toBe('lalo')
    await field.setValue('lalol')
    expect(wrapper.emitted('search')).toEqual([['lalol']])
  })

  // AMENDED for #165: the maintainer reversed the "Cropper is confirmed and
  // deliberate" ruling on 2026-09-03. This chip read 'Cropper'; it now pins
  // 'Copper' instead.
  it('offers one chip per tier, All first', () => {
    expect(
      panel()
        .findAll('.tier-chip')
        .map((chip) => chip.text())
    ).toEqual(['All', 'Bronze', 'Copper', 'Silver', 'Gold', 'Uranium'])
  })

  it('marks All selected when no tier is filtered', () => {
    const wrapper = panel({ tier: null })
    expect(chipAt(wrapper, 0).classes()).toContain('is-selected')
    expect(chipAt(wrapper, 1).classes()).not.toContain('is-selected')
  })

  it('marks the filtered tier selected instead', () => {
    const wrapper = panel({ tier: 'silver' })
    expect(chipAt(wrapper, 0).classes()).not.toContain('is-selected')
    expect(chipAt(wrapper, 3).classes()).toContain('is-selected')
  })

  it('asks for a tier when its chip is pressed', async () => {
    const wrapper = panel({ tier: null })
    await chipAt(wrapper, 2).trigger('click')
    expect(wrapper.emitted('tier')).toEqual([['copper']])
  })

  it('asks for no tier at all when All is pressed', async () => {
    const wrapper = panel({ tier: 'gold' })
    await chipAt(wrapper, 0).trigger('click')
    expect(wrapper.emitted('tier')).toEqual([[null]])
  })

  /*
   * AMENDED for #135: the two date-order tests below asserted the control's
   * TEXT ('Newest first' / 'Oldest first'). The design draws this control as
   * the `filter.svg` glyph and nothing else, so the wording moved to the hover
   * line — the accessible name stays stable and the title carries the state,
   * the same split App.vue's pin button uses. Nothing was dropped: both
   * directions are still pinned, one assertion lower down.
   */
  it('flips the activity order from one labelled button', async () => {
    const wrapper = panel({ direction: 'desc' })
    const sort = wrapper.get('.sort-control')
    expect(sort.attributes('title')).toBe('Most recent activity first')
    await sort.trigger('click')
    expect(wrapper.emitted('toggle-direction')).toHaveLength(1)
  })

  it('says which way the list runs once it is flipped', () => {
    expect(panel({ direction: 'asc' }).get('.sort-control').attributes('title')).toBe(
      'Least recent activity first'
    )
  })

  /* The header row the mock draws: title, search field, then two icons (#135). */
  it('draws the date order as the designer glyph rather than as words', () => {
    const sort = panel().get('.sort-control')
    expect(sort.text()).toBe('')
    expect(sort.get('.control-glyph').attributes('style')).toContain('--control-icon')
  })

  it('keeps a stable accessible name on the activity order while the hover line moves', () => {
    expect(panel({ direction: 'asc' }).get('.sort-control').attributes('aria-label')).toBe(
      'Order by last activity'
    )
  })

  it('rules the header off from the list the way the mock does', () => {
    expect(panel().find('.panel-header').classes()).toContain('panel-header')
    expect(panel().find('.header-divider').exists()).toBe(true)
  })
})

describe('MinesPanel list', () => {
  it('draws one card per project', () => {
    const wrapper = panel({
      projects: [defaultProject({ id: 'a', name: 'a' }), defaultProject({ id: 'b', name: 'b' })]
    })
    expect(wrapper.findAll('.mine-card')).toHaveLength(2)
  })

  it('counts the crew from the board for a live project', () => {
    const wrapper = panel({
      projects: [defaultProject({ id: 'C:/dev/alpha', live: true })],
      mines: [
        defaultMine({
          id: 'C:/dev/alpha',
          dwarfs: [defaultDwarf({ id: '1' }), defaultDwarf({ id: '2' })]
        })
      ]
    })
    // AMENDED for #135: the mock capitalizes it — see the note in MineCard.test.ts.
    expect(wrapper.get('.card-agents').text()).toBe('Active Agents: 2')
  })

  /* The markers are joined off the same board the crew count comes from (#135). */
  it('raises a card marker from the board rather than from the row', () => {
    const wrapper = panel({
      projects: [defaultProject({ id: 'C:/dev/alpha', live: true })],
      mines: [
        defaultMine({
          id: 'C:/dev/alpha',
          dwarfs: [defaultDwarf({ id: '1', status: 'waiting' })]
        })
      ]
    })
    expect(wrapper.find('.status-resting').exists()).toBe(true)
  })

  it('raises no marker for a project the board does not carry', () => {
    const wrapper = panel({
      projects: [defaultProject({ id: 'C:/dev/alpha', live: true })],
      mines: []
    })
    expect(wrapper.find('.card-status').exists()).toBe(false)
  })

  it('opens the mine a live card names', async () => {
    const wrapper = panel({
      projects: [defaultProject({ id: 'C:/dev/alpha', live: true })],
      mines: [defaultMine({ id: 'C:/dev/alpha' })]
    })
    await wrapper.get('.mine-card button').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['C:/dev/alpha']])
  })
})

describe('MinesPanel empty and failed states', () => {
  it('centres the two-line invitation when nothing matched', () => {
    const wrapper = panel({ projects: [] })
    expect(wrapper.get('.panel-empty').text()).toContain('Nothing here')
    expect(wrapper.get('.panel-empty').text()).toContain('Add your project.')
  })

  it('does not claim emptiness while the first page is still loading', () => {
    expect(panel({ projects: [], loading: true }).find('.panel-empty').exists()).toBe(false)
  })

  it('shows a refusal as a failure, never as an empty list', () => {
    // answered:false and "no projects yet" are both zero rows; the panel must
    // not tell a user their history is gone.
    const wrapper = panel({ projects: [], error: 'The projects database could not be opened.' })
    expect(wrapper.find('.panel-empty').exists()).toBe(false)
    expect(wrapper.get('.panel-error').text()).toBe('The projects database could not be opened.')
  })

  it('announces the failure rather than leaving it to be noticed', () => {
    const wrapper = panel({ error: 'broken' })
    expect(wrapper.get('.panel-error').attributes('role')).toBe('alert')
  })
})

describe('MinesPanel infinite list', () => {
  it('asks for the next page when the sentinel comes into view', async () => {
    const wrapper = panel({ projects: [defaultProject()] })
    await nextTick()
    enterView()
    expect(wrapper.emitted('load-more')).toHaveLength(1)
  })

  it('watches nothing once the list is exhausted', async () => {
    const wrapper = panel({ projects: [defaultProject()], exhausted: true })
    await nextTick()
    expect(wrapper.find('.list-sentinel').exists()).toBe(false)
    enterView()
    expect(wrapper.emitted('load-more')).toBeUndefined()
  })

  it('stops watching once a refusal has ended the paging', async () => {
    const wrapper = panel({ projects: [defaultProject()], error: 'broken' })
    await nextTick()
    expect(wrapper.find('.list-sentinel').exists()).toBe(false)
    enterView()
    expect(wrapper.emitted('load-more')).toBeUndefined()
  })

  it('re-observes the sentinel after a page lands', async () => {
    // A page that does not push the sentinel off screen delivers no new
    // intersection, and the list would stall with the sentinel still in view.
    const wrapper = panel({ projects: [defaultProject({ id: 'a' })] })
    await nextTick()
    expect(onlyObserver().observed).toBe(1)
    await wrapper.setProps({
      projects: [defaultProject({ id: 'a' }), defaultProject({ id: 'b' })]
    })
    expect(onlyObserver().observed).toBe(2)
  })

  it('lets go of the observer when the panel closes', async () => {
    const wrapper = panel({ projects: [defaultProject()] })
    await nextTick()
    wrapper.unmount()
    expect(onlyObserver().disconnected).toBe(true)
  })
})

/* Adopting a folder from the panel (#85). */
describe('MinesPanel add control', () => {
  it('sits in the controls row beside the date order', () => {
    const wrapper = panel()
    const controls = wrapper.findAll('.panel-header button').map((button) => button.classes())
    expect(controls).toEqual([
      expect.arrayContaining(['sort-control']),
      expect.arrayContaining(['add-control'])
    ])
  })

  it('is a real keyboard-reachable button with a stable name', () => {
    const add = panel().get('.add-control')
    expect(add.attributes('type')).toBe('button')
    expect(add.attributes('aria-label')).toBe('Add a project')
  })

  /*
   * AMENDED for #135: this asserted a hand-drawn inline <svg>, which the design
   * replaces with the designer's own `add.svg` drawn through a mask. The claim
   * it protects is unchanged and still asserted — the control is art, never
   * text or an emoji.
   */
  it('draws the control as the designer glyph, not text or emoji', () => {
    const add = panel().get('.add-control')
    expect(add.get('.control-glyph').attributes('style')).toContain('--control-icon')
    expect(add.text()).toBe('')
  })

  it('asks for a folder when pressed', async () => {
    const wrapper = panel()
    await wrapper.get('.add-control').trigger('click')
    expect(wrapper.emitted('add')).toHaveLength(1)
  })

  it('is disabled while main is showing the picker', async () => {
    const wrapper = panel({ adding: true })
    expect(wrapper.get('.add-control').attributes('disabled')).toBeDefined()
    await wrapper.get('.add-control').trigger('click')
    expect(wrapper.emitted('add')).toBeUndefined()
  })

  it('states why a folder could not be added', () => {
    const wrapper = panel({ addError: 'That folder could not be saved as a mine.' })
    expect(wrapper.get('.add-error').text()).toBe('That folder could not be saved as a mine.')
    expect(wrapper.get('.add-error').attributes('role')).toBe('alert')
  })

  it('says nothing when there is nothing to say about the last add', () => {
    // A closed picker reaches the panel as no notice at all: backing out of a
    // folder chooser is a decision, not a fault to report.
    expect(panel({ addError: null }).find('.add-error').exists()).toBe(false)
  })

  it('keeps a failed add apart from a browse that could not be read', () => {
    const wrapper = panel({ error: 'The projects could not be read.', addError: 'refused' })
    expect(wrapper.get('.panel-error').text()).toBe('The projects could not be read.')
    expect(wrapper.get('.add-error').text()).toBe('refused')
  })

  it('does not let a failed add stand in for an empty list', () => {
    // The list was read and found nothing; the folder that was refused is a
    // separate fact and must not replace the invitation to add one.
    const wrapper = panel({ projects: [], addError: 'refused' })
    expect(wrapper.get('.panel-empty').text()).toContain('Nothing here')
  })
})

/**
 * One world for the map and the list (#165).
 *
 * The map draws the board and this list draws store rows, so a mine could stand
 * on the map with no card anywhere here. Every board mine main can say the
 * store holds no row for now gets a card built from the board itself.
 */
describe('MinesPanel board-and-list coherence', () => {
  const boardOnly = defaultMine({
    id: 'mine:live',
    path: 'C:\dev\scratch',
    name: 'scratch',
    unrecorded: true
  })

  it('lists a board mine the store has no row for', () => {
    const wrapper = panel({ projects: [], mines: [boardOnly] })

    const names = wrapper.findAll('.card-name').map((card) => card.text())
    expect(names).toEqual(['scratch'])
  })

  it('marks it as unrecorded rather than passing it off as a stored project', () => {
    const wrapper = panel({ projects: [], mines: [boardOnly] })

    expect(wrapper.get('.card-unrecorded').text()).toBe('Working now - not recorded yet')
  })

  it('puts it in front of the page the store answered with', () => {
    const wrapper = panel({
      projects: [defaultProject({ id: 'mine:stored', name: 'stored' })],
      mines: [boardOnly]
    })

    expect(wrapper.findAll('.card-name').map((card) => card.text())).toEqual(['scratch', 'stored'])
  })

  it('draws one card, not two, once the store row arrives', () => {
    const wrapper = panel({
      projects: [defaultProject({ id: 'mine:live', name: 'scratch' })],
      mines: [boardOnly]
    })

    expect(wrapper.findAll('.card-name')).toHaveLength(1)
    expect(wrapper.find('.card-unrecorded').exists()).toBe(false)
  })

  it('is not the empty state, because the list is not empty', () => {
    const wrapper = panel({ projects: [], mines: [boardOnly] })

    expect(wrapper.find('.panel-empty').exists()).toBe(false)
  })

  it('still says nothing is here when the board adds nothing either', () => {
    expect(panel({ projects: [], mines: [] }).find('.panel-empty').exists()).toBe(true)
  })
})

/**
 * Removing a mine from the list (#169).
 *
 * The confirmation is held HERE, exactly as SettingsPanel holds the reset
 * modal's open state: which mine is awaiting confirmation is display state
 * nothing outside this screen reads, while the confirmed intent leaves as an
 * event so App keeps owning the IPC.
 */
describe('MinesPanel removing a mine', () => {
  const stored = defaultProject({ id: 'mine:lalo', name: 'Lalo-Test' })

  it('asks before it removes anything, naming the mine', async () => {
    const wrapper = panel({ projects: [stored] })

    await wrapper.get('.card-remove').trigger('click')

    expect(wrapper.get('.modal-message').text()).toContain('Lalo-Test')
    expect(wrapper.emitted('remove')).toBeUndefined()
  })

  it('reports the removal only once it is confirmed', async () => {
    const wrapper = panel({ projects: [stored] })

    await wrapper.get('.card-remove').trigger('click')
    await wrapper.get('.modal-confirm').trigger('click')

    expect(wrapper.emitted('remove')).toEqual([['mine:lalo']])
  })

  it('removes nothing when the confirmation is dismissed', async () => {
    const wrapper = panel({ projects: [stored] })

    await wrapper.get('.card-remove').trigger('click')
    await wrapper.get('.modal-close').trigger('click')

    expect(wrapper.emitted('remove')).toBeUndefined()
    expect(wrapper.find('.remove-modal').exists()).toBe(false)
  })

  it('closes the confirmation once the mine is gone from the list', async () => {
    // The card is the feedback, and the modal named a mine that no longer has
    // one: leaving it open would ask about a card that is not there.
    const wrapper = panel({ projects: [stored] })
    await wrapper.get('.card-remove').trigger('click')

    await wrapper.setProps({ projects: [] })

    expect(wrapper.find('.remove-modal').exists()).toBe(false)
  })

  it('keeps the confirmation open, with the reason, when the removal failed', async () => {
    const wrapper = panel({ projects: [stored], removeError: 'The database is locked.' })

    await wrapper.get('.card-remove').trigger('click')

    expect(wrapper.get('.modal-error').text()).toBe('The database is locked.')
  })

  it('locks the confirmation while main is working on it', async () => {
    const wrapper = panel({ projects: [stored], removing: true })

    await wrapper.get('.card-remove').trigger('click')

    expect(wrapper.get('.modal-confirm').attributes('disabled')).toBeDefined()
  })

  it('shows no confirmation until one is asked for', () => {
    expect(
      panel({ projects: [stored] })
        .find('.remove-modal')
        .exists()
    ).toBe(false)
  })
})
