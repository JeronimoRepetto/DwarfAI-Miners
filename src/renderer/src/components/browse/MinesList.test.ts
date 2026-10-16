// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MinesList from './MinesList.vue'
import type { MineCardView } from '../../lib/browse/mineCard'
import { MINE_CARD_ENTER, MINE_CARD_EXIT } from '../../lib/browse/cardMotion'
import type { MotionAnimate } from '../../lib/shell/boundedMotion'
import { motionBoundMs } from '../../lib/shell/motionTiming'

/*
 * The redesigned Mines page (#635), organisms/mines-list. It replaces MinesPanel (#92, #85, #165,
 * #169, #348, #538) and its three modals, whose test files went with them (MinesPanel.test.ts 60,
 * RemoveMineModal.test.ts 12, TierInfoModal.test.ts 9, WorktreeFoldModal.test.ts 13). Where each
 * group's guarantee lives now:
 * - chrome (title, search keystrokes, chips All first and which is selected, asking for a tier):
 *   here. The activity-order button and its glyph went with the date order: the page sorts by
 *   tier, name or needs you (lib/browse/minesList.test.ts, "sort orders"). The ruled header line is
 *   not in the redesign.
 * - list (a card per project, crew and markers from the board, opening a live card): here, and
 *   MineCard.test.ts / lib/browse/mineCard.test.ts for what a card claims.
 * - empty and failed states: here ("claims no emptiness while the list is still being read",
 *   "reports a list that could not be read…"); the words are lib/browse/minesList.test.ts's.
 * - the infinite list's sentinel: gone with paging on scroll; a read takes every page
 *   (useProjectBrowse.test.ts, "useProjectBrowse paging").
 * - the add control (a named button, disabled while the picker is up, a failed add said apart
 *   from an unreadable list): PageHeader.test.ts and here.
 * - board-and-list coherence (#165): lib/browse/boardRows.test.ts, and App.test.ts "lists a board
 *   mine the store has no row for, as working but not recorded yet".
 * - removing a mine and RemoveMineModal (asks first, naming the mine; reports only a confirmed
 *   removal; dismissal removes nothing; closes once the mine is gone; keeps the reason; locks
 *   while main works; Esc): here, and ModalDialog.test.ts "cancels on Esc".
 * - the worktree question and WorktreeFoldModal (asks only with a question, reports the answer or
 *   a dismissal, locks while adopting, never offers the worktree itself): here; the sentence naming
 *   folder, project, branch or commit is lib/worktree.test.ts's. The close glyph is gone: the
 *   redesigned dialog has Cancel and Esc.
 * - tier info and TierInfoModal (in the page's corner, opens and closes, every tier in order with
 *   its range and its mound kept out of the name): here and TierInfo.test.ts.
 * - motion-v press/hover variants and AnimatePresence on these controls and popups (#566): not
 *   carried over. The redesign's controls press and hover in their own CSS (atoms/button), and
 *   its overlays enter and leave by motion.md's Overlays table (ModalDialog, MenuButton).
 */

const card = (over: Partial<MineCardView>): MineCardView => ({
  id: over.name ?? 'x',
  name: 'x',
  tier: 'silver',
  measured: true,
  state: 'active',
  ore: [],
  crew: [],
  needs: false,
  needsCount: 0,
  enterable: true,
  removable: true,
  ...over
})

const valley = [
  card({ name: 'beta', tier: 'copper', score: 200 }),
  card({ name: 'alpha', tier: 'gold', score: 3000 })
]

const base = { cards: valley, openId: null, search: '', tier: null, sort: 'tier' as const }

afterEach(() => {
  document.body.innerHTML = ''
})

const names = (list: ReturnType<typeof mount>) =>
  list
    .findAll('.dm-card')
    .filter((c) => c.isVisible())
    .map((c) => c.get('.dm-card__name').text())

describe('MinesList', () => {
  it('is a section named Mines: the page header, the tier chips, the list and its foot', () => {
    const list = mount(MinesList, { props: base })
    expect(list.attributes('aria-label')).toBe('Mines')
    expect(list.get('.dm-phead__title').text()).toBe('Mines')
    expect(list.get('.dm-mines__chips').attributes()).toMatchObject({
      role: 'radiogroup',
      'aria-label': 'Filter by tier'
    })
    expect(list.findAll('.dm-mines__chips [role="radio"]').map((c) => c.text())).toEqual([
      'All',
      'Bronze',
      'Copper',
      'Silver',
      'Gold',
      'Uranium'
    ])
    expect(list.get('.dm-mines__list').attributes('role')).toBe('list')
    expect(list.get('.dm-mines__count').text()).toBe('2 of 2 mines')
  })

  it('draws every card in the order in force, richest tier first by default', () => {
    expect(names(mount(MinesList, { props: base }))).toEqual(['alpha', 'beta'])
    expect(names(mount(MinesList, { props: { ...base, sort: 'name' } }))).toEqual(['alpha', 'beta'])
  })

  it('hides the cards a search leaves out, and counts what is shown', () => {
    const list = mount(MinesList, { props: { ...base, search: 'bet' } })
    expect(names(list)).toEqual(['beta'])
    expect(list.get('.dm-mines__count').text()).toBe('1 of 2 mines')
  })

  it('checks the chip of the tier in force', () => {
    const list = mount(MinesList, { props: { ...base, tier: 'gold' } })
    const checked = list
      .findAll('[role="radio"]')
      .filter((c) => c.attributes('aria-checked') === 'true')
    expect(checked.map((c) => c.text())).toEqual(['Gold'])
    expect(names(list)).toEqual(['alpha'])
  })

  it('asks for a tier, and for All, from the chips', async () => {
    const list = mount(MinesList, { props: base })
    const chips = list.findAll('[role="radio"]')
    await chips[4]!.trigger('click')
    await chips[0]!.trigger('click')
    expect(list.emitted('tier')).toEqual([['gold'], [null]])
  })

  it('names the order in force on the sort button, and asks for the next one', async () => {
    const list = mount(MinesList, { props: base })
    const sort = list.get('button[title^="Sort: "]')
    expect(sort.attributes('title')).toBe('Sort: Tier, richest first')
    await sort.trigger('click')
    expect(list.emitted('sort')).toEqual([['name']])
  })

  it('hands every keystroke of the search on', async () => {
    const list = mount(MinesList, { props: base })
    await list.get('input[type="search"]').setValue('al')
    expect(list.emitted('search')).toEqual([['al']])
  })

  it('on a first run says No mines yet over the primary Add a mine, which adds', async () => {
    const list = mount(MinesList, { props: { ...base, cards: [] } })
    expect(list.get('.dm-empty__title').text()).toBe('No mine found')
    expect(list.get('.dm-empty__text').text()).toBe('No mines yet.')
    const add = list.get('.dm-empty button')
    expect(add.classes()).toContain('dm-btn--primary')
    expect(add.text()).toBe('Add a mine')
    await add.trigger('click')
    expect(list.emitted('add')).toHaveLength(1)
    expect(list.get('.dm-mines__count').text()).toBe('0 of 0 mines')
  })

  it('offers Clear search when a search finds nothing, clearing the search and the tier', async () => {
    const list = mount(MinesList, { props: { ...base, search: 'zz', tier: 'gold' } })
    expect(list.get('.dm-empty__text').text()).toBe('Nothing matches “zz” in Gold.')
    await list.get('.dm-empty button').trigger('click')
    expect(list.emitted('search')).toEqual([['']])
    expect(list.emitted('tier')).toEqual([[null]])
  })

  it('asks for an add from the header, held while one is under way', async () => {
    const list = mount(MinesList, { props: { ...base, adding: true } })
    const add = list.get('.dm-phead button[title="Add a mine"]')
    expect(add.attributes('disabled')).toBeDefined()
  })

  it('opens the mine a card names, and marks the open one', async () => {
    const list = mount(MinesList, { props: { ...base, openId: 'beta' } })
    expect(list.get('[data-mine="beta"]').attributes('data-open')).toBe('true')
    await list.get('[data-mine="alpha"] .dm-card__hit').trigger('click')
    expect(list.emitted('open')).toEqual([['alpha']])
  })

  it('confirms a removal first, naming the mine, and removes only once confirmed', async () => {
    const list = mount(MinesList, { props: base, attachTo: document.body })
    await list.get('[data-mine="beta"] .dm-card__menu').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[role="menuitem"]')!.click()
    await flushPromises()
    const dialog = document.body.querySelector('.dm-scrim [role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Remove beta?')
    expect(dialog.textContent).toContain(
      'The mine leaves the valley and its dwarfs are sent home. The project folder and its ore stay on disk.'
    )
    expect(list.emitted('remove')).toBeUndefined()
    const [cancel, remove] = [...dialog.querySelectorAll<HTMLElement>('.dm-dialog__actions button')]
    expect(cancel!.textContent).toBe('Cancel')
    remove!.click()
    expect(list.emitted('remove')).toEqual([['beta']])
    list.unmount()
  })

  it('removes nothing when the confirmation is cancelled', async () => {
    const list = mount(MinesList, { props: base, attachTo: document.body })
    await list.get('[data-mine="beta"] .dm-card__menu').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[role="menuitem"]')!.click()
    await flushPromises()
    document.body.querySelector<HTMLElement>('.dm-dialog__actions button')!.click()
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
    expect(list.emitted('remove')).toBeUndefined()
    list.unmount()
  })

  it('closes the confirmation once the mine is gone, and keeps it, with the reason, when it failed', async () => {
    const list = mount(MinesList, { props: base, attachTo: document.body })
    await list.get('[data-mine="beta"] .dm-card__menu').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[role="menuitem"]')!.click()
    await flushPromises()
    await list.setProps({ removeError: 'The store is locked.' })
    expect(document.body.querySelector('.dm-scrim [role="alert"]')?.textContent).toBe(
      'The store is locked.'
    )
    await list.setProps({ removing: true })
    const remove = document.body.querySelectorAll<HTMLButtonElement>(
      '.dm-dialog__actions button'
    )[1]
    expect(remove!.disabled).toBe(true)
    await list.setProps({ cards: [valley[1]!], removing: false, removeError: null })
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
    list.unmount()
  })

  it('asks the worktree question over the page, Cancel first, and answers it', async () => {
    const list = mount(MinesList, {
      props: {
        ...base,
        worktreeQuestion: { worktree: 'C:/dev/alpha-wt', root: 'C:/dev/alpha', branch: 'fix' }
      },
      attachTo: document.body
    })
    await flushPromises()
    const dialog = document.body.querySelector('.dm-scrim [role="dialog"]')!
    // The story's words (US-MINES-004.AC07); the title and action these replaced were
    // "This folder is a worktree" and "Open the main project".
    expect(dialog.getAttribute('aria-label')).toBe('alpha-wt is a worktree of alpha')
    const [cancel, open] = [...dialog.querySelectorAll<HTMLElement>('.dm-dialog__actions button')]
    expect(cancel!.textContent).toBe('Cancel')
    expect(open!.textContent).toBe('Add alpha')
    open!.click()
    cancel!.click()
    expect(list.emitted('open-main-project')).toHaveLength(1)
    expect(list.emitted('dismiss-worktree')).toHaveLength(1)
    list.unmount()
  })

  it('opens the tier and ore explainer from its quiet corner, and closes it', async () => {
    const list = mount(MinesList, { props: base, attachTo: document.body })
    await list.get('.dm-mines__foot button[title="Tiers and ore"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('.dm-scrim .dm-dialog--wide')!
    expect(dialog.getAttribute('aria-label')).toBe('Tiers and ore')
    expect(dialog.querySelector('.dm-tinfo')).not.toBeNull()
    dialog.querySelector<HTMLElement>('.dm-dialog__actions button')!.click()
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
    list.unmount()
  })

  it('claims no emptiness while the list is still being read', () => {
    const list = mount(MinesList, { props: { ...base, cards: [], loading: true } })
    expect(list.find('.dm-empty').exists()).toBe(false)
    expect(list.get('[role="status"]').text()).toBe('Reading your projects...')
  })

  it('holds the worktree dialog s Add while main is adopting, so it cannot fire twice', async () => {
    const list = mount(MinesList, {
      props: {
        ...base,
        adding: true,
        worktreeQuestion: { worktree: 'C:/dev/alpha-wt', root: 'C:/dev/alpha', branch: 'fix' }
      },
      attachTo: document.body
    })
    await flushPromises()
    const open = document.body.querySelectorAll<HTMLButtonElement>('.dm-dialog__actions button')[1]
    expect(open!.disabled).toBe(true)
    open!.click()
    expect(list.emitted('open-main-project')).toBeUndefined()
    list.unmount()
  })

  it('reports a list that could not be read as a failure, never as an empty list', () => {
    const list = mount(MinesList, {
      props: { ...base, cards: [], error: 'The database is locked.' }
    })
    expect(list.get('[role="alert"]').text()).toBe('The database is locked.')
    expect(list.find('.dm-empty').exists()).toBe(false)
  })

  it('states why a folder could not be added', () => {
    const list = mount(MinesList, {
      props: { ...base, addError: 'That folder could not be added.' }
    })
    expect(list.get('[role="alert"]').text()).toBe('That folder could not be added.')
  })
})

// PANEL-QUESTIONS 6: a press on a card that cannot be entered is passed up for the page to say why.
describe('MinesList refusing a mine', () => {
  it('passes up a press on a card that cannot be entered', async () => {
    const list = mount(MinesList, {
      props: {
        ...base,
        cards: [card({ name: 'old', state: 'unenterable', enterable: false, reason: 'gone' })]
      }
    })
    await list.get('button.dm-card__hit').trigger('click')
    expect(list.emitted('refuse')).toEqual([['old']])
  })
})

/*
 * APPENDED for #635 (PANEL-QUESTIONS 9, design lead ruling 2026-09-27): an added mine's card
 * enters rising from transparent and then scrolls into view; a removed mine's card slides left to
 * transparent and holds its last frame until it is removed, the cards below closing the gap at
 * once. Every other card that comes or goes (the first read, the board catching up) has no motion.
 * Driven through the bounded runner with a hand-written engine, as PanelTransition.test.ts does;
 * `HTMLElement.prototype.animate` is stubbed only because `still()` reads its presence.
 */
describe('MinesList card motion (#635, PANEL-QUESTIONS 9)', () => {
  const runs: { element: Element; keyframes: unknown; transition: unknown; finish: () => void }[] =
    []
  const engine: MotionAnimate = (element, keyframes, transition) => {
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    runs.push({ element, keyframes, transition, finish })
    return {
      cancel: () => undefined,
      then: (onResolve: () => void, onReject?: () => void) => finished.then(onResolve, onReject)
    }
  }
  // test-utils stubs TransitionGroup by default, which would never call the page's hooks.
  const UNSTUBBED = { stubs: { 'transition-group': false } }
  const scrolled: string[] = []
  beforeEach(() => {
    runs.length = 0
    scrolled.length = 0
    /*
     * The bounded runner's watchdog (#266) is a timer of its own; on real timers it ended a run
     * whenever the host stalled past its bound, racing the engine every case here drives by hand
     * (found failing in CI). Faked, it fires only when a case advances it. `flushPromises` turns on
     * `setImmediate`, which stays real.
     */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: () => undefined
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        scrolled.push(this.dataset.mine ?? '')
      }
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(HTMLElement.prototype, 'animate')
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  })

  it('enters an added mine’s card rising from transparent, then scrolls it into view', async () => {
    const list = mount(MinesList, {
      props: { ...base, engine },
      attachTo: document.body,
      global: UNSTUBBED
    })
    const added = card({ name: 'gamma', tier: 'bronze' })
    await list.setProps({ cards: [...valley, added], revealId: 'gamma' })
    await flushPromises()
    expect(runs).toHaveLength(1)
    expect((runs[0]!.element as HTMLElement).dataset.mine).toBe('gamma')
    expect(runs[0]!.keyframes).toEqual(MINE_CARD_ENTER.keyframes)
    expect(runs[0]!.transition).toEqual(MINE_CARD_ENTER.transition)
    expect(scrolled).not.toContain('gamma')
    runs[0]!.finish()
    await flushPromises()
    expect(scrolled).toContain('gamma')
    list.unmount()
  })

  it('rises once: a filter hiding and showing the added card again moves nothing', async () => {
    const list = mount(MinesList, {
      props: { ...base, engine },
      attachTo: document.body,
      global: UNSTUBBED
    })
    await list.setProps({ cards: [...valley, card({ name: 'gamma' })], revealId: 'gamma' })
    await flushPromises()
    runs.splice(0).forEach((run) => run.finish())
    await flushPromises()
    await list.setProps({ tier: 'gold' })
    await list.setProps({ tier: null })
    await flushPromises()
    expect(runs).toEqual([])
    list.unmount()
  })

  // APPENDED for #635 (found in the live app): the add reloads the list before it names the new
  // mine, so its card is on screen before revealId arrives; the rise plays on that same card.
  it('rises in a card already on screen once it is named as the mine just added', async () => {
    const list = mount(MinesList, {
      props: { ...base, engine },
      attachTo: document.body,
      global: UNSTUBBED
    })
    await list.setProps({ cards: [...valley, card({ name: 'gamma' })] })
    await flushPromises()
    expect(runs).toEqual([])
    const onScreen = list.get('[data-mine="gamma"]').element
    await list.setProps({ revealId: 'gamma' })
    await flushPromises()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.element).toBe(onScreen)
    expect(runs[0]!.keyframes).toEqual(MINE_CARD_ENTER.keyframes)
    expect(scrolled).not.toContain('gamma')
    runs[0]!.finish()
    await flushPromises()
    expect(scrolled).toContain('gamma')
    list.unmount()
  })

  it('moves no card that arrives by any other road', async () => {
    const list = mount(MinesList, { props: { ...base, cards: [], engine }, global: UNSTUBBED })
    await list.setProps({ cards: valley })
    await flushPromises()
    expect(runs).toEqual([])
    expect(list.findAll('.dm-card')).toHaveLength(2)
  })

  it('slides a removed mine’s card out, holding its last frame until it is gone', async () => {
    const list = mount(MinesList, {
      props: { ...base, engine },
      attachTo: document.body,
      global: UNSTUBBED
    })
    await list.get('[data-mine="beta"] .dm-card__menu').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[role="menuitem"]')!.click()
    await flushPromises()
    document.body.querySelectorAll<HTMLElement>('.dm-dialog__actions button')[1]!.click()
    await list.setProps({ cards: [valley[1]!] })
    await flushPromises()
    expect(runs).toHaveLength(1)
    const leaving = runs[0]!.element as HTMLElement
    expect(leaving.dataset.mine).toBe('beta')
    expect(runs[0]!.keyframes).toEqual(MINE_CARD_EXIT.keyframes)
    expect(runs[0]!.transition).toEqual(MINE_CARD_EXIT.transition)
    expect(list.find('[data-mine="beta"]').exists()).toBe(true)
    runs[0]!.finish()
    await flushPromises()
    expect(list.find('[data-mine="beta"]').exists()).toBe(false)
    list.unmount()
  })

  it('removes the card at once where there is no motion to run', async () => {
    Reflect.deleteProperty(HTMLElement.prototype, 'animate')
    const list = mount(MinesList, {
      props: { ...base, engine },
      attachTo: document.body,
      global: UNSTUBBED
    })
    await list.get('[data-mine="beta"] .dm-card__menu').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[role="menuitem"]')!.click()
    await flushPromises()
    document.body.querySelectorAll<HTMLElement>('.dm-dialog__actions button')[1]!.click()
    await list.setProps({ cards: [valley[1]!] })
    await flushPromises()
    expect(runs).toEqual([])
    expect(list.find('[data-mine="beta"]').exists()).toBe(false)
    list.unmount()
  })

  /*
   * APPENDED for #635 (measured in the live app: the enter never rose, the exit never slid, and
   * the added card flashed at full opacity on its first frame). The card's own stylesheet
   * transitions `transform` over --dur-press with a stepped ease, for its press; the engine writes
   * `transform` inline every frame, and each write restarted that transition before its first step,
   * so the card never moved. The page suspends the transition for as long as the motion owns the
   * card, and puts it at its from-state before it is ever painted.
   */
  const inline = (el: Element) => {
    const style = (el as HTMLElement).style
    return { opacity: style.opacity, transform: style.transform, transition: style.transition }
  }

  it('starts the rise at its from-state, the card’s own transition suspended', async () => {
    const list = mount(MinesList, {
      props: { ...base, engine },
      attachTo: document.body,
      global: UNSTUBBED
    })
    await list.setProps({ cards: [...valley, card({ name: 'gamma' })], revealId: 'gamma' })
    await flushPromises()
    expect(runs).toHaveLength(1)
    expect(inline(runs[0]!.element)).toEqual({
      opacity: '0',
      transform: 'translateY(6px)',
      transition: 'none'
    })
    runs[0]!.finish()
    await flushPromises()
    // Handed back to the stylesheet: the press transition works again once the rise is over.
    expect(inline(runs[0]!.element)).toEqual({ opacity: '', transform: '', transition: '' })
    list.unmount()
  })

  it('holds a card inserted while an add is under way at its from-state, then rises it', async () => {
    const list = mount(MinesList, {
      props: { ...base, engine, adding: true },
      attachTo: document.body,
      global: UNSTUBBED
    })
    await list.setProps({ cards: [...valley, card({ name: 'gamma' })] })
    await flushPromises()
    const inserted = list.get('[data-mine="gamma"]').element
    expect(runs).toEqual([])
    expect(inline(inserted)).toEqual({
      opacity: '0',
      transform: 'translateY(6px)',
      transition: 'none'
    })
    // The app's own order: the add ends, then names the mine it made.
    await list.setProps({ adding: false })
    await list.setProps({ revealId: 'gamma' })
    await flushPromises()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.element).toBe(inserted)
    expect(inline(inserted).opacity).toBe('0')
    list.unmount()
  })

  it('lets a held card appear at once when the add ends without naming it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const list = mount(MinesList, {
        props: { ...base, engine, adding: true },
        attachTo: document.body,
        global: UNSTUBBED
      })
      await list.setProps({ cards: [...valley, card({ name: 'gamma' })] })
      await flushPromises()
      await list.setProps({ adding: false })
      vi.advanceTimersByTime(0)
      await flushPromises()
      expect(runs).toEqual([])
      expect(inline(list.get('[data-mine="gamma"]').element)).toEqual({
        opacity: '',
        transform: '',
        transition: ''
      })
      list.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('slides the removed card out with the card’s own transition suspended', async () => {
    const list = mount(MinesList, {
      props: { ...base, engine },
      attachTo: document.body,
      global: UNSTUBBED
    })
    await list.get('[data-mine="beta"] .dm-card__menu').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[role="menuitem"]')!.click()
    await flushPromises()
    document.body.querySelectorAll<HTMLElement>('.dm-dialog__actions button')[1]!.click()
    await list.setProps({ cards: [valley[1]!] })
    await flushPromises()
    expect(runs).toHaveLength(1)
    expect(inline(runs[0]!.element).transition).toBe('none')
    list.unmount()
  })

  /*
   * APPENDED (fix/mineslist-motion-flake): "slides a removed mine's card out…" failed in CI on
   * Linux and Windows with the card already gone before the engine finished. The bounded runner
   * also ends a run on its watchdog, a timer one margin past the motion's length (#266); on real
   * timers, a host busy for longer than that between the slide starting and the test looking ended
   * the slide before the engine did. The watchdog is the runner's, and this describe holds its clock.
   */
  it('holds the leaving card while the host stalls past the watchdog, until its motion ends', async () => {
    const list = mount(MinesList, {
      props: { ...base, engine },
      attachTo: document.body,
      global: UNSTUBBED
    })
    await list.get('[data-mine="beta"] .dm-card__menu').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[role="menuitem"]')!.click()
    await flushPromises()
    document.body.querySelectorAll<HTMLElement>('.dm-dialog__actions button')[1]!.click()
    await list.setProps({ cards: [valley[1]!] })
    expect(runs).toHaveLength(1)
    // A loaded CI worker, in wall-clock time: the event loop turns until the bound has passed.
    const stalledUntil =
      Date.now() + motionBoundMs(MINE_CARD_EXIT.keyframes, MINE_CARD_EXIT.transition) + 20
    while (Date.now() < stalledUntil) await new Promise<void>((turn) => setImmediate(turn))
    await flushPromises()
    expect(list.find('[data-mine="beta"]').exists()).toBe(true)
    runs[0]!.finish()
    await flushPromises()
    expect(list.find('[data-mine="beta"]').exists()).toBe(false)
    list.unmount()
  })

  // APPENDED with the case above: the watchdog the cases hold still bounds the slide (#266).
  it('removes the leaving card at the watchdog when its motion never reports ending (#266)', async () => {
    const list = mount(MinesList, {
      props: { ...base, engine },
      attachTo: document.body,
      global: UNSTUBBED
    })
    await list.get('[data-mine="beta"] .dm-card__menu').trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[role="menuitem"]')!.click()
    await flushPromises()
    document.body.querySelectorAll<HTMLElement>('.dm-dialog__actions button')[1]!.click()
    await list.setProps({ cards: [valley[1]!] })
    expect(runs).toHaveLength(1)
    const bound = motionBoundMs(MINE_CARD_EXIT.keyframes, MINE_CARD_EXIT.transition)
    vi.advanceTimersByTime(bound - 1)
    await flushPromises()
    expect(list.find('[data-mine="beta"]').exists()).toBe(true)
    vi.advanceTimersByTime(1)
    await flushPromises()
    expect(list.find('[data-mine="beta"]').exists()).toBe(false)
    list.unmount()
  })
})

/*
 * ISSUE-253: the Mines page against its acceptance criteria. The cards stand for the Host's read
 * model (ADR-033 item 3): tier, score, measured and the needs-you count are given, never derived
 * here. The parent owns search, tier and sort; a test stands in for it by feeding each emitted
 * value back as its prop.
 */
describe('MinesList acceptance (ISSUE-253)', () => {
  const countOf = (list: ReturnType<typeof mount>) => list.get('.dm-mines__count').text()
  const dialogEl = () => document.body.querySelector<HTMLElement>('.dm-scrim [role="dialog"]')!
  const dialogButtons = () => [
    ...document.body.querySelectorAll<HTMLElement>('.dm-scrim .dm-dialog__actions button')
  ]
  const escape = () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  it('[US-MINES-001.AC06, US-MINES-001.AC07, US-MINES-001.AC02, NFR-A11Y-02] the search field shows × only with text and its placeholder when empty, and × or Esc clears the query', async () => {
    const list = mount(MinesList, { props: base, attachTo: document.body })
    const input = list.get<HTMLInputElement>('input[type="search"]')
    const clear = list.get('button[aria-label="Clear search"]')
    expect(input.attributes('placeholder')).toBe('Search by name')
    expect(clear.attributes('hidden')).toBeDefined()

    await input.setValue('al')
    await list.setProps({ search: 'al' })
    expect(input.element.value).toBe('al')
    expect(clear.attributes('hidden')).toBeUndefined()
    expect(names(list)).toEqual(['alpha'])

    await clear.trigger('click')
    expect(list.emitted('search')!.at(-1)).toEqual([''])
    await list.setProps({ search: '' })
    expect(names(list)).toEqual(['alpha', 'beta'])
    expect(clear.attributes('hidden')).toBeDefined()

    await input.setValue('be')
    await list.setProps({ search: 'be', tier: 'copper' })
    await input.trigger('keydown', { key: 'Escape' })
    expect(list.emitted('search')!.at(-1)).toEqual([''])
    // The query clears; the tier filter stays, so the tier-filtered list returns.
    await list.setProps({ search: '' })
    expect(names(list)).toEqual(['beta'])
    expect(list.emitted('tier')).toBeUndefined()
    list.unmount()
  })

  it('[US-MINES-001.AC08, US-MINES-005.AC05] the footer reads shown of total mines in every state, including 0 of 0', async () => {
    const list = mount(MinesList, { props: base })
    expect(countOf(list)).toBe('2 of 2 mines')
    await list.setProps({ search: 'alp' })
    expect(countOf(list)).toBe('1 of 2 mines')
    await list.setProps({ search: 'zz' })
    expect(list.find('.dm-empty').exists()).toBe(true)
    expect(countOf(list)).toBe('0 of 2 mines')
    await list.setProps({ search: '', tier: 'uranium' })
    expect(countOf(list)).toBe('0 of 2 mines')
    await list.setProps({ tier: null, cards: [] })
    expect(countOf(list)).toBe('0 of 0 mines')
  })

  it('[US-MINES-002.AC04] the chips read All, Bronze, Copper, Silver, Gold, Uranium in a row named Filter by tier', () => {
    const list = mount(MinesList, { props: base })
    const row = list.get('[aria-label="Filter by tier"]')
    expect(row.findAll('[role="radio"]').map((c) => c.text())).toEqual([
      'All',
      'Bronze',
      'Copper',
      'Silver',
      'Gold',
      'Uranium'
    ])
  })

  it('[US-MINES-002.AC01, US-MINES-002.AC05] a second tier chip replaces the first, single-select', async () => {
    // Attached: whether a card is shown after the filter changes is read from the live layout.
    const list = mount(MinesList, { props: base, attachTo: document.body })
    const chip = (label: string) => list.findAll('[role="radio"]').find((c) => c.text() === label)!
    const checked = () =>
      list
        .findAll('[role="radio"]')
        .filter((c) => c.attributes('aria-checked') === 'true')
        .map((c) => c.text())
    await chip('Gold').trigger('click')
    expect(list.emitted('tier')!.at(-1)).toEqual(['gold'])
    await list.setProps({ tier: 'gold' })
    expect(checked()).toEqual(['Gold'])
    expect(names(list)).toEqual(['alpha'])
    await chip('Copper').trigger('click')
    expect(list.emitted('tier')!.at(-1)).toEqual(['copper'])
    await list.setProps({ tier: 'copper' })
    expect(checked()).toEqual(['Copper'])
    expect(names(list)).toEqual(['beta'])
    list.unmount()
  })

  it('[US-MINES-001.AC03, US-MINES-005.AC01, US-MINES-005.AC06, US-MINES-005.AC04] a search with no match shows No mine found with its body and Clear search, which resets search and tier together', async () => {
    const list = mount(MinesList, { props: { ...base, search: 'zz' } })
    expect(names(list)).toEqual([])
    expect(list.get('.dm-empty__title').text()).toBe('No mine found')
    expect(list.get('.dm-empty__text').text()).toBe('Nothing matches “zz”.')
    await list.setProps({ tier: 'gold' })
    expect(list.get('.dm-empty__text').text()).toBe('Nothing matches “zz” in Gold.')
    const clear = list.get('.dm-empty button')
    expect(clear.text()).toBe('Clear search')
    await clear.trigger('click')
    expect(list.emitted('search')).toEqual([['']])
    expect(list.emitted('tier')).toEqual([[null]])
    // Clear search is there only while a search is: with the search gone, so is the button.
    await list.setProps({ search: '', tier: 'uranium' })
    expect(list.find('.dm-empty button').exists()).toBe(false)
  })

  it('[US-MINES-002.AC08, US-MINES-005.AC02] a tier filter with no mine shows No Tier mine yet. and no button', () => {
    const list = mount(MinesList, { props: { ...base, tier: 'uranium' } })
    expect(list.get('.dm-empty__title').text()).toBe('No mine found')
    expect(list.get('.dm-empty__text').text()).toBe('No Uranium mine yet.')
    expect(list.find('.dm-empty button').exists()).toBe(false)
  })

  it('[US-MINES-005.AC03] with no mine at all the page reads No mines yet. with Add a mine', async () => {
    const list = mount(MinesList, { props: { ...base, cards: [] } })
    expect(list.get('.dm-empty__text').text()).toBe('No mines yet.')
    const add = list.get('.dm-empty button')
    expect(add.text()).toBe('Add a mine')
    expect(add.classes()).toContain('dm-btn--primary')
    await add.trigger('click')
    expect(list.emitted('add')).toHaveLength(1)
  })

  it('[US-MINES-003.AC07] the sort button s name reads Sort: and the current order', async () => {
    const list = mount(MinesList, { props: base })
    const title = () => list.get('.dm-phead button[title^="Sort: "]').attributes('title')
    expect(title()).toBe('Sort: Tier, richest first')
    await list.setProps({ sort: 'name' })
    expect(title()).toBe('Sort: Name')
    await list.setProps({ sort: 'needs' })
    expect(title()).toBe('Sort: Needs you first')
  })

  it('[US-MINES-004.AC04] a successful add never opens the Add panel', async () => {
    // The page asks for an add and nothing else; the App-level journey (folder picked, mine opened
    // in the mine column, no AddPanel) is App.test.ts "opens the mine just added in the mine
    // column once main publishes it".
    const list = mount(MinesList, { props: { ...base, cards: [] }, attachTo: document.body })
    await list.get('.dm-empty button').trigger('click')
    await list.setProps({ adding: true })
    await list.setProps({ adding: false, cards: valley, revealId: 'alpha' })
    await flushPromises()
    // The page's own requests: one add, and nothing that opens a panel or a mine.
    expect(list.emitted('add')).toHaveLength(1)
    for (const request of ['open', 'refuse', 'open-main-project', 'dismiss-worktree']) {
      expect(list.emitted(request)).toBeUndefined()
    }
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
    list.unmount()
  })

  it('[US-MINES-004.AC07] the worktree dialog shows its title, body and the actions Cancel and Add mine', async () => {
    const list = mount(MinesList, {
      props: {
        ...base,
        worktreeQuestion: {
          worktree: 'C:\\dev\\alpha-worktrees\\fix-ore',
          root: 'C:\\dev\\alpha',
          branch: 'fix/ore'
        }
      },
      attachTo: document.body
    })
    await flushPromises()
    expect(dialogEl().getAttribute('aria-label')).toBe('fix-ore is a worktree of alpha')
    expect(dialogEl().querySelector('.dm-dialog__title')!.textContent).toBe(
      'fix-ore is a worktree of alpha'
    )
    expect(dialogEl().querySelector('.dm-dialog__body')!.textContent).toBe(
      'Its dwarfs will work in alpha.'
    )
    expect(dialogButtons().map((b) => b.textContent)).toEqual(['Cancel', 'Add alpha'])
    list.unmount()
  })

  it('[US-MINES-006.AC01, US-MINES-006.AC08, US-MINES-006.AC02, BR-18, NFR-A11Y-03] the card menu offers only Remove mine…, whose danger dialog shows its title, body and actions, and Cancel leaves the mine untouched', async () => {
    const list = mount(MinesList, { props: base, attachTo: document.body })
    await list.get('[data-mine="alpha"] .dm-card__menu').trigger('click')
    await flushPromises()
    const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.map((i) => i.textContent)).toEqual(['Remove mine…'])
    items[0]!.click()
    await flushPromises()
    // BR-18: nothing is removed by asking.
    expect(list.emitted('remove')).toBeUndefined()
    expect(dialogEl().classList).toContain('dm-dialog--danger')
    expect(dialogEl().querySelector('.dm-dialog__title')!.textContent).toBe('Remove alpha?')
    expect(dialogEl().querySelector('.dm-dialog__body p')!.textContent).toBe(
      'The mine leaves the valley and its dwarfs are sent home. The project folder and its ore stay on disk.'
    )
    const [cancel, remove] = dialogButtons()
    expect([cancel!.textContent, remove!.textContent]).toEqual(['Cancel', 'Remove mine'])
    expect(remove!.classList).toContain('dm-btn--danger')
    // NFR-A11Y-03: the dialog takes the focus on Cancel, the safe action.
    expect(document.activeElement).toBe(cancel)
    cancel!.click()
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
    expect(list.emitted('remove')).toBeUndefined()
    expect(names(list)).toEqual(['alpha', 'beta'])
    list.unmount()
  })

  it('[US-MINES-007.AC01, US-MINES-007.AC03, US-MINES-007.AC04, BR-15] the footer icon named Tiers and ore opens the modal with the five tiers in order, and Esc or Close returns focus to it', async () => {
    const list = mount(MinesList, { props: base, attachTo: document.body })
    const icon = list.get<HTMLButtonElement>('.dm-mines__foot button[title="Tiers and ore"]')
    expect(icon.attributes('aria-label') ?? icon.attributes('title')).toBe('Tiers and ore')

    const open = async () => {
      icon.element.focus()
      await icon.trigger('click')
      await flushPromises()
    }
    await open()
    expect(dialogEl().getAttribute('aria-label')).toBe('Tiers and ore')
    const rows = [...dialogEl().querySelectorAll('.dm-tinfo__row')]
    expect(rows.map((r) => r.querySelector('.dm-tier')!.textContent)).toEqual([
      'Bronze',
      'Copper',
      'Silver',
      'Gold',
      'Uranium'
    ])
    expect(
      rows.every((r) => / KB( and up)?$/.test(r.querySelector('.dm-tinfo__range')!.textContent!))
    ).toBe(true)
    escape()
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
    expect(document.activeElement).toBe(icon.element)

    await open()
    dialogButtons()
      .find((b) => b.textContent === 'Close')!
      .click()
    await flushPromises()
    expect(document.body.querySelector('.dm-scrim')).toBeNull()
    expect(document.activeElement).toBe(icon.element)
    list.unmount()
  })
})
