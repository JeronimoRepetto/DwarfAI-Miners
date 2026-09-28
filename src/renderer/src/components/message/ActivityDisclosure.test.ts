// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ActivityDisclosure from './ActivityDisclosure.vue'

/*
 * One run of tool steps (#294, #635), `molecules/activity`: a disclosure button whose name is its
 * label, controlling the step list (components.md, Activity disclosure, Accessibility), and the
 * forced hover look the UI kit draws, as every control here takes one.
 */
function run(props: Record<string, unknown> = {}) {
  return mount(ActivityDisclosure, {
    props: {
      label: '2 steps · activity',
      open: false,
      lines: [
        { key: 'a', text: 'Read skills/README.md', target: 'skills/README.md' },
        { key: 'b', text: 'Ran skill-sync' }
      ],
      ...props
    }
  })
}

describe('ActivityDisclosure (#635)', () => {
  it('names the toggle by its label, in a part of its own beside the caret', () => {
    const toggle = run().find('.dm-activity__toggle')
    expect(toggle.find('.dm-activity__label').text()).toBe('2 steps · activity')
    expect(toggle.text()).toBe('2 steps · activity')
    expect(toggle.attributes('aria-expanded')).toBe('false')
  })

  it('draws the forced hover look only when asked', () => {
    expect(run().find('.dm-activity__toggle').classes()).not.toContain('is-hover')
    expect(run({ state: 'hover' }).find('.dm-activity__toggle').classes()).toContain('is-hover')
  })

  it('opens to its steps, a step that names a file being a button that opens it', async () => {
    const wrapper = run({ open: true })
    expect(wrapper.find('.dm-activity__list').attributes('hidden')).toBeUndefined()
    await wrapper.find('.dm-activity__path').trigger('click')
    expect(wrapper.emitted('open-path')).toEqual([[{ key: 'a', target: 'skills/README.md' }]])
    await wrapper.find('.dm-activity__toggle').trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)
  })
})
