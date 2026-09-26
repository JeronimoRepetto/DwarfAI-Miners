// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ChoiceChip from './ChoiceChip.vue'
import MetaChip from './MetaChip.vue'
import TierChip from './TierChip.vue'

describe('ChoiceChip', () => {
  it('is a native button carrying the material recipe, its label its only part', () => {
    const chip = mount(ChoiceChip, { props: { label: 'All' } })
    expect(chip.element.tagName).toBe('BUTTON')
    expect(chip.attributes('type')).toBe('button')
    expect(chip.classes()).toEqual(['dm-chip', 'm-mat'])
    expect(chip.attributes('aria-pressed')).toBeUndefined()
    expect(chip.element.children).toHaveLength(0)
    expect(chip.text()).toBe('All')
  })

  it('draws a tier gem before the label of a tier filter', () => {
    const chip = mount(ChoiceChip, { props: { label: 'Bronze', tier: 'bronze', pressed: false } })
    expect(chip.attributes('data-tier')).toBe('bronze')
    expect(chip.attributes('aria-pressed')).toBe('false')
    expect(chip.element.firstElementChild!.className).toBe('dm-gem')
    expect(chip.text()).toBe('Bronze')
  })

  it('draws an icon before the label when it has one', () => {
    const chip = mount(ChoiceChip, { props: { label: 'Claude', icon: 'check' } })
    expect(chip.element.firstElementChild!.classList.contains('dm-icon')).toBe(true)
  })

  it('reports a click, and a disabled one never fires', async () => {
    const onClick = vi.fn()
    await mount(ChoiceChip, { props: { label: 'All', onClick } }).trigger('click')
    expect(onClick).toHaveBeenCalledTimes(1)
    const disabled = mount(ChoiceChip, { props: { label: 'Other…', disabled: true } })
    expect((disabled.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('is a radio stating aria-checked inside a radiogroup', () => {
    const chip = mount(ChoiceChip, { props: { label: 'Right', role: 'radio', pressed: true } })
    expect(chip.attributes('role')).toBe('radio')
    expect(chip.attributes('aria-checked')).toBe('true')
  })
})

describe('TierChip', () => {
  it('is the tier word with its gem, carrying the tier', () => {
    const chip = mount(TierChip, { props: { tier: 'copper' } })
    expect(chip.element.tagName).toBe('SPAN')
    expect(chip.classes()).toEqual(['dm-tier'])
    expect(chip.attributes('data-tier')).toBe('copper')
    expect(chip.element.firstElementChild!.className).toBe('dm-gem')
    // The redesign's label for the second tier (#165).
    expect(chip.text()).toBe('Copper')
  })
})

describe('MetaChip', () => {
  it('is a sunken fact, not pressable, whose tooltip is the fact itself', () => {
    const chip = mount(MetaChip, { props: { text: 'worktree: main' } })
    expect(chip.element.tagName).toBe('SPAN')
    expect(chip.classes()).toEqual(['dm-meta'])
    expect(chip.attributes('title')).toBe('worktree: main')
    expect(chip.text()).toBe('worktree: main')
  })

  it('takes a title in place of the fact when one is given', () => {
    const chip = mount(MetaChip, { props: { text: 'main', title: 'Worktree' } })
    expect(chip.attributes('title')).toBe('Worktree')
  })
})
