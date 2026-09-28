// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PositionSettings from './PositionSettings.vue'

/**
 * The Position section of the redesigned Settings screen (#138,
 * screens/settings.md): a Left/Right segmented control, Right the default,
 * persisted by whoever owns the IPC (App.vue) — this component only ever
 * renders the edge it is given and asks for a different one.
 */
function render(props: { edge?: 'left' | 'right'; applying?: boolean } = {}) {
  return mount(PositionSettings, {
    props: { edge: props.edge ?? 'right', applying: props.applying ?? false }
  })
}

describe('PositionSettings — rendering', () => {
  it('names the section and both segments', () => {
    const wrapper = render()
    expect(wrapper.text()).toContain('Position')
    expect(wrapper.find('.position-left').text()).toBe('Left')
    expect(wrapper.find('.position-right').text()).toBe('Right')
  })

  // AMENDED (#635): the design's row has its own help line (screens/settings.md, W6 General),
  // which replaces today's "Select Left or Right to place the panel at the edges of the screen."
  it('gives the helper copy exactly as the design states it', () => {
    expect(render().find('.dm-srow__help').text()).toBe('The screen edge the panel docks to.')
  })

  // AMENDED (#635): the chips are radios in a radiogroup now, so the state is aria-checked
  // (was aria-pressed on two toggle buttons).
  it('marks the current edge as pressed and the other as not', () => {
    const right = render({ edge: 'right' })
    expect(right.find('.position-right').attributes('aria-checked')).toBe('true')
    expect(right.find('.position-left').attributes('aria-checked')).toBe('false')

    const left = render({ edge: 'left' })
    expect(left.find('.position-left').attributes('aria-checked')).toBe('true')
    expect(left.find('.position-right').attributes('aria-checked')).toBe('false')
  })

  it('offers Right before Left, as radios in one group named by the row', () => {
    const wrapper = render()
    const group = wrapper.get('[role="radiogroup"]')
    expect(group.findAll('[role="radio"]').map((radio) => radio.text())).toEqual(['Right', 'Left'])
    expect(wrapper.get(`#${group.attributes('aria-labelledby')}`).text()).toBe('Position')
  })

  it('uses real buttons, so every segment is keyboard operable', () => {
    const wrapper = render()
    for (const button of wrapper.findAll('button')) {
      expect(button.attributes('type')).toBe('button')
    }
  })
})

describe('PositionSettings — choosing a side', () => {
  it('asks for the other edge when its segment is clicked', async () => {
    const wrapper = render({ edge: 'right' })
    await wrapper.find('.position-left').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['left']])
  })

  it('still asks even when the already-selected segment is clicked', async () => {
    // A segmented control keeps both segments clickable; the owner (App.vue)
    // is what may choose to no-op an unchanged request.
    const wrapper = render({ edge: 'right' })
    await wrapper.find('.position-right').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['right']])
  })

  it('locks both segments while a move is in flight', () => {
    const wrapper = render({ applying: true })
    expect(wrapper.find('.position-left').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.position-right').attributes('disabled')).toBeDefined()
  })
})
