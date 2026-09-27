// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import MineCard from './MineCard.vue'
import type { MineCardView } from '../../lib/browse/mineCard'

/*
 * The redesigned mine card (#635), molecules/mine-card. It replaces the card of #92/#135/#165/
 * #169, whose 42 tests went with it. Where each group's guarantee lives now:
 * - naming and tier art (the measured tier or the weight's, nothing claimed unmeasured): here and
 *   lib/browse/mineCard.test.ts; the first-run ruling draws an unmeasured mine as Bronze,
 *   measuring, a placeholder that never answers a tier filter (lib/browse/minesList.test.ts).
 * - resources (one capsule per material, compacted, named in words, none for an empty ledger):
 *   here, lib/browse/mineCard.test.ts, and atoms/ore's own OreCapsule tests.
 * - crew, status markers (the "Active Agents" count and the asking/resting glyphs): the crew line
 *   of pills, lib/browse/mineCard.test.ts "crewPills" and here.
 * - level bar and its column placement: the full-width tier progress, here and
 *   lib/browse/tierProgress.test.ts; the old grid tracks went with the old layout.
 * - action (only a live mine opens): here, "opens nothing for a mine that cannot be entered".
 * - while measuring: lib/browse/mineCard.test.ts, "draws a declared mine nobody has measured…".
 * - removal (named, reports only the card's mine, none for an unrecorded row): the ⋯ menu, here
 *   and lib/browse/mineCard.test.ts "mineCardMenu".
 * - motion-v press/hover on the removal button: gone with the button; the card presses in its own
 *   CSS, as the design's mine-card.css does.
 */

const view = (over: Partial<MineCardView> = {}): MineCardView => ({
  id: 'm1',
  name: 'alpha',
  tier: 'silver',
  measured: true,
  state: 'active',
  ore: [
    { material: 'coal', units: 548 },
    { material: 'bronze', units: 90 }
  ],
  crew: [{ text: '2 working' }, { text: '1 needs you', tone: 'needs', ask: true }],
  needs: true,
  needsCount: 1,
  progress: { value: 1630, max: 2048, nextTier: 'gold' },
  enterable: true,
  removable: true,
  ...over
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('MineCard', () => {
  it('is an article carrying the mine, its tier, its state and whether it waits on you', () => {
    const card = mount(MineCard, { props: { card: view() } })
    expect(card.element.tagName).toBe('ARTICLE')
    expect(card.attributes()).toMatchObject({
      'data-mine': 'm1',
      'data-tier': 'silver',
      'data-state': 'active',
      'data-needs': 'true'
    })
    expect(card.attributes('data-open')).toBeUndefined()
  })

  it('puts the tier chip and the name on one line, the name titled in full', () => {
    const card = mount(MineCard, { props: { card: view() } })
    expect(card.get('.dm-card__title .dm-tier').text()).toBe('Silver')
    expect(card.get('.dm-card__name').attributes('title')).toBe('alpha')
  })

  it('draws one capsule per material, never a sum', () => {
    const ore = mount(MineCard, { props: { card: view() } }).findAll('.dm-card__ore .dm-ore')
    expect(ore.map((o) => o.attributes('aria-label'))).toEqual(['Coal: 548', 'Bronze: 90'])
  })

  it('draws the crew line as pills, needs you its own dark pill', () => {
    const pills = mount(MineCard, { props: { card: view() } }).findAll('.dm-card__crew .dm-pill')
    expect(pills.map((p) => p.text())).toEqual(['2 working', '?1 needs you'])
    expect(pills[1]!.classes()).toContain('dm-pill--needs')
  })

  it('runs the progress under both columns, toward the next tier', () => {
    const card = mount(MineCard, { props: { card: view() } })
    const bar = card.get('.dm-card__progress [role="progressbar"]')
    expect(bar.attributes()).toMatchObject({ 'aria-valuenow': '1630', 'aria-valuemax': '2048' })
    expect(card.get('.dm-card__progress .dm-progress').attributes('data-tier')).toBe('gold')
  })

  it('says a mine is working but not recorded yet where its progress would be', () => {
    const card = mount(MineCard, {
      props: { card: view({ state: 'unrecorded', progress: undefined }) }
    })
    expect(card.get('.dm-card__progress .dm-card__note .dm-pill--info').text()).toBe(
      'Working · not recorded yet'
    )
  })

  it('says why a mine cannot be entered, in words, in place of its progress', () => {
    const card = mount(MineCard, {
      props: {
        card: view({ state: 'unenterable', progress: undefined, reason: 'Folder not found.' })
      }
    })
    expect(card.find('.dm-card__progress').exists()).toBe(false)
    const note = card.get(':scope > .dm-card__note')
    expect(note.get('.dm-pill--warn').text()).toBe('Not enterable')
    expect(note.text()).toContain('Folder not found.')
    expect(card.get('.dm-card__hit').attributes()).toMatchObject({
      'aria-disabled': 'true',
      'aria-label': 'Open alpha, Silver, not enterable'
    })
  })

  it('is one button named for what it opens, and opens its mine', async () => {
    const card = mount(MineCard, { props: { card: view() } })
    const hit = card.get('button.dm-card__hit')
    expect(hit.attributes('aria-label')).toBe('Open alpha, Silver')
    await hit.trigger('click')
    expect(card.emitted('open')).toEqual([['m1']])
  })

  it('opens nothing for a mine that cannot be entered', async () => {
    const card = mount(MineCard, { props: { card: view({ enterable: false }) } })
    const hit = card.get('button.dm-card__hit')
    expect(hit.attributes('aria-disabled')).toBe('true')
    await hit.trigger('click')
    expect(card.emitted('open')).toBeUndefined()
  })

  it('marks the open mine with its brackets and aria-current, never a colour', () => {
    const card = mount(MineCard, { props: { card: view(), open: true } })
    expect(card.attributes('data-open')).toBe('true')
    expect(card.classes()).toContain('m-brackets')
    expect(card.get('.dm-card__hit').attributes('aria-current')).toBe('true')
  })

  it('keeps its menu button apart from the card button, named for the mine', () => {
    const card = mount(MineCard, { props: { card: view() } })
    const menu = card.get('.dm-card__menu')
    expect(menu.element.closest('.dm-card__hit')).toBeNull()
    expect(menu.attributes('aria-label')).toBe('More for alpha')
  })

  it('asks for the removal from its menu', async () => {
    const card = mount(MineCard, { props: { card: view() }, attachTo: document.body })
    await card.get('.dm-card__menu').trigger('click')
    await flushPromises()
    const item = document.body.querySelector<HTMLElement>('[role="menuitem"]')!
    expect(item.textContent).toBe('Remove mine…')
    item.click()
    await flushPromises()
    expect(card.emitted('remove')).toEqual([['m1']])
    card.unmount()
  })
})

/*
 * PANEL-QUESTIONS 6 (design lead ruling 2026-09-27): a mine is not enterable only when its folder
 * no longer exists, and the reason is "Folder not found. It was moved or deleted." — after the
 * "Not enterable" pill on its card, as the card button's title, and in the toast "<name>: <reason>".
 */
describe('MineCard not enterable', () => {
  it('reports a press on a mine that cannot be entered, so the page can say why', async () => {
    const card = mount(MineCard, {
      props: { card: view({ state: 'unenterable', enterable: false, reason: 'Folder not found.' }) }
    })
    await card.get('button.dm-card__hit').trigger('click')
    expect(card.emitted('open')).toBeUndefined()
    expect(card.emitted('refuse')).toEqual([['m1']])
  })
})
