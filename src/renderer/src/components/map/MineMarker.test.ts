// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import MineMarker from './MineMarker.vue'

describe('MineMarker', () => {
  it('draws one hexagon carrying the mine’s tier', () => {
    const wrapper = mount(MineMarker, { props: { mine: defaultMine({ tier: 'gold' }) } })
    expect(wrapper.get('.mine-marker').attributes('data-tier')).toBe('gold')
    expect(wrapper.findAll('.marker-hex')).toHaveLength(1)
  })

  /*
    The tier a marker is DRAWN as, which for an unwalked project is the
    provisional bronze `tierOf()` hands out (#41). Drawing is exactly what that
    placeholder is for; nothing here records it anywhere.
  */
  it('draws an unwalked mine as the tier the board stamped for drawing', () => {
    const wrapper = mount(MineMarker, { props: { mine: defaultMine({ tier: 'bronze' }) } })
    expect(wrapper.get('.mine-marker').attributes('data-tier')).toBe('bronze')
  })

  it('emits open with the mine id when the marker is clicked', async () => {
    const wrapper = mount(MineMarker, {
      props: { mine: defaultMine({ id: 'C:/dev/beta', name: 'beta' }) }
    })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['C:/dev/beta']])
  })

  /*
    The marker itself is 10px wide and carries no text, so everything a screen
    reader or a keyboard user has to go on is this label. The design says
    nothing about either — accessibility is listed as needing definition — so
    the label carries what the tooltip carries, which is the most that is known.
  */
  it('names the mine, its tier and its crew for anyone not using a pointer', () => {
    const wrapper = mount(MineMarker, {
      props: {
        mine: defaultMine({ name: 'forge', tier: 'copper', dwarfs: [defaultDwarf()] })
      }
    })
    const label = wrapper.get('button').attributes('aria-label')
    expect(label).toContain('forge')
    expect(label).toContain('Cropper')
    expect(label).toContain('1')
  })

  it('is reachable by keyboard, being a real button', () => {
    const wrapper = mount(MineMarker, { props: { mine: defaultMine() } })
    expect(wrapper.get('button').attributes('type')).toBe('button')
  })
})
