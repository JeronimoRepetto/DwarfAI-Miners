// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../testing/factories'
import DwarfSprite from './DwarfSprite.vue'

describe('DwarfSprite', () => {
  it('gives a worker a pickaxe and no clipboard', () => {
    const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ role: 'worker' }) } })
    expect(wrapper.find('.pickaxe').exists()).toBe(true)
    expect(wrapper.find('.clipboard').exists()).toBe(false)
  })

  it('gives a foreman a clipboard and no pickaxe', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', name: 'Boss' }) }
    })
    expect(wrapper.find('.clipboard').exists()).toBe(true)
    expect(wrapper.find('.pickaxe').exists()).toBe(false)
  })

  it('applies the animation class for its status', () => {
    for (const [status, cls] of [
      ['working', 'is-working'],
      ['waiting', 'is-waiting'],
      ['leaving', 'is-leaving']
    ] as const) {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status }) } })
      expect(wrapper.classes()).toContain(cls)
    }
  })

  it('emits activate when clicked', async () => {
    const dwarf = defaultDwarf()
    const wrapper = mount(DwarfSprite, { props: { dwarf } })
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('activate')).toHaveLength(1)
  })

  it('shows a speech bubble only when bubble text is provided', () => {
    const silent = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
    expect(silent.find('.speech-bubble').exists()).toBe(false)
    const talking = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf(), bubbleText: 'Refactoring the parser' }
    })
    expect(talking.find('.speech-bubble').text()).toContain('Refactoring the parser')
  })

  it('describes the dwarf in its tooltip', () => {
    const wrapper = mount(DwarfSprite, {
      props: {
        dwarf: defaultDwarf({
          name: 'Gimli',
          provider: 'codex',
          model: 'gpt-test',
          effort: 'high',
          status: 'waiting'
        })
      }
    })
    const tooltip = wrapper.find('.dwarf-tooltip')
    for (const detail of ['Gimli', 'codex', 'gpt-test', 'high', 'Waiting']) {
      expect(tooltip.text()).toContain(detail)
    }
  })
})
