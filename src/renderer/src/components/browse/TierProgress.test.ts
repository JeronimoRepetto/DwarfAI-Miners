// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TierProgress from './TierProgress.vue'

describe('TierProgress', () => {
  it('is a progress bar toward the next tier, named for it', () => {
    const progress = mount(TierProgress, { props: { value: 1630, max: 2048, nextTier: 'gold' } })
    expect(progress.classes()).toEqual(['dm-progress'])
    expect(progress.attributes('data-tier')).toBe('gold')
    expect(progress.get('.dm-progress__row').text()).toBe('Next: Gold1,630 / 2,048')
    const track = progress.get('.dm-progress__track')
    expect(track.attributes()).toMatchObject({
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '2048',
      'aria-valuenow': '1630',
      'aria-label': 'Progress to Gold'
    })
    expect(track.get('.dm-progress__fill').attributes('style')).toBe('--p: 0.796;')
  })

  it('announces measuring as a status, with a scan in place of a fill', () => {
    const progress = mount(TierProgress, { props: { measuring: true } })
    expect(progress.attributes('role')).toBe('status')
    expect(progress.attributes('data-tier')).toBeUndefined()
    expect(progress.get('.dm-progress__row b').text()).toBe('Measuring…')
    expect(progress.get('.dm-progress__num').text()).toBe('—')
    expect(progress.find('[role="progressbar"]').exists()).toBe(false)
    expect(progress.find('.dm-progress__scan').exists()).toBe(true)
  })

  it('shows "Max tier" without a bar at the top tier', () => {
    const progress = mount(TierProgress, { props: { value: 9412, maxTier: true } })
    expect(progress.classes()).toEqual(['dm-progress', 'dm-progress--max'])
    expect(progress.get('.dm-progress__row').text()).toBe('Max tier9,412')
    expect(progress.find('.dm-progress__track').exists()).toBe(false)
  })
})
