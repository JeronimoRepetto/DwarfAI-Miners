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

  it('offers one chip per tier, All first', () => {
    expect(
      panel()
        .findAll('.tier-chip')
        .map((chip) => chip.text())
    ).toEqual(['All', 'Bronze', 'Cropper', 'Silver', 'Gold', 'Uranium'])
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

  it('flips the date order from one labelled button', async () => {
    const wrapper = panel({ direction: 'desc' })
    const sort = wrapper.get('.sort-control')
    expect(sort.text()).toBe('Newest first')
    await sort.trigger('click')
    expect(wrapper.emitted('toggle-direction')).toHaveLength(1)
  })

  it('says which way the list runs once it is flipped', () => {
    expect(panel({ direction: 'asc' }).get('.sort-control').text()).toBe('Oldest first')
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
    expect(wrapper.get('.card-agents').text()).toBe('Active agents: 2')
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

  it('draws the control as inline pixel art, not text or emoji', () => {
    const add = panel().get('.add-control')
    expect(add.find('svg').exists()).toBe(true)
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
