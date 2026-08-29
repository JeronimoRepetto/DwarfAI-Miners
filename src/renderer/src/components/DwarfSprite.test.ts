// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDwarf } from '../testing/factories'
import DwarfSprite from './DwarfSprite.vue'

/** The pose file a sprite is currently showing, e.g. "dwarf-pick-1". */
function poseOf(wrapper: ReturnType<typeof mount>): string {
  const src = wrapper.find('.dwarf-frame').attributes('src') ?? ''
  return (
    src
      .split('/')
      .pop()
      ?.replace(/\.png.*$/, '') ?? ''
  )
}

describe('DwarfSprite', () => {
  it('swings a pickaxe while a worker is working', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'worker', status: 'working' }) }
    })
    expect(poseOf(wrapper)).toBe('dwarf-pick-1')
  })

  it('puts the foreman on his own pose instead of a pickaxe', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', name: 'Boss', status: 'working' }) }
    })
    expect(poseOf(wrapper)).toBe('dwarf-foreman-idle')
  })

  it('rests a waiting worker and shows the zzz overlay', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'waiting' }) }
    })
    expect(poseOf(wrapper)).toBe('dwarf-rest-1')
    expect(wrapper.find('.zzz').exists()).toBe(true)
  })

  it('walks a leaving dwarf and mirrors it toward the exit', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'leaving' }) }
    })
    expect(poseOf(wrapper)).toBe('dwarf-walk-1')
    expect(wrapper.classes()).toContain('is-flipped')
  })

  it('does not mirror a dwarf that is staying put', () => {
    const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status: 'working' }) } })
    expect(wrapper.classes()).not.toContain('is-flipped')
  })

  it('stands neutral while its terminal is being focused', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), activating: true }
    })
    expect(poseOf(wrapper)).toBe('dwarf-idle')
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

  it('marks the provider with a badge instead of tinting the painted art', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ provider: 'codex' }) }
    })
    expect(wrapper.find('.provider-dot').classes()).toContain('provider-codex')
  })

  describe('action menu', () => {
    it('opens the action menu on click instead of activating straight away', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      expect(wrapper.find('.action-menu').exists()).toBe(false)

      await wrapper.find('.dwarf-hit').trigger('click')
      expect(wrapper.find('.action-menu').exists()).toBe(true)
      expect(wrapper.emitted('activate')).toBeUndefined()
    })

    it('closes the menu on a second click', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      await wrapper.find('.dwarf-hit').trigger('click')
      await wrapper.find('.dwarf-hit').trigger('click')
      expect(wrapper.find('.action-menu').exists()).toBe(false)
    })

    it('emits activate and closes when the console action is chosen', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      await wrapper.find('.dwarf-hit').trigger('click')
      await wrapper.find('.action-open').trigger('click')

      expect(wrapper.emitted('activate')).toHaveLength(1)
      expect(wrapper.find('.action-menu').exists()).toBe(false)
    })

    it('forwards a composed message and keeps the menu open for the verdict', async () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ textDelivery: 'terminal' }) }
      })
      await wrapper.find('.dwarf-hit').trigger('click')
      await wrapper.find('.action-send').trigger('click')
      await wrapper.find('.message-input').setValue('run the tests')
      await wrapper.find('.send-button').trigger('click')

      expect(wrapper.emitted('send-text')).toEqual([[{ text: 'run the tests', pressEnter: true }]])
      expect(wrapper.find('.action-menu').exists()).toBe(true)
    })

    it('marks a delivered message on the dwarf', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf(), sendState: { phase: 'delivered', via: 'terminal' } }
      })
      expect(wrapper.find('.send-result').classes()).toContain('is-delivered')
    })

    it('marks a failed message and carries its reason', () => {
      const wrapper = mount(DwarfSprite, {
        props: {
          dwarf: defaultDwarf(),
          sendState: { phase: 'failed', error: 'The terminal would not come forward.' }
        }
      })
      const marker = wrapper.find('.send-result')
      expect(marker.classes()).toContain('is-failed')
      expect(marker.attributes('title')).toBe('The terminal would not come forward.')
    })

    it('shows no marker while nothing has been sent', () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      expect(wrapper.find('.send-result').exists()).toBe(false)
    })
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

  describe('tooltip visibility', () => {
    it('hides the tooltip until the sprite is hovered or focused', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      expect(wrapper.find('.tooltip-holder').classes()).not.toContain('is-visible')

      await wrapper.find('.dwarf-hit').trigger('mouseenter')
      expect(wrapper.find('.tooltip-holder').classes()).toContain('is-visible')

      await wrapper.find('.dwarf-hit').trigger('mouseleave')
      expect(wrapper.find('.tooltip-holder').classes()).not.toContain('is-visible')
    })

    it('also shows the tooltip on keyboard focus', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      await wrapper.find('.dwarf-hit').trigger('focus')
      expect(wrapper.find('.tooltip-holder').classes()).toContain('is-visible')
      await wrapper.find('.dwarf-hit').trigger('blur')
      expect(wrapper.find('.tooltip-holder').classes()).not.toContain('is-visible')
    })
  })

  describe('frame cycling', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('alternates the two working poses on the pick cadence', async () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status: 'working' }) }
      })
      expect(poseOf(wrapper)).toBe('dwarf-pick-1')
      vi.advanceTimersByTime(550)
      await wrapper.vm.$nextTick()
      expect(poseOf(wrapper)).toBe('dwarf-pick-2')
      vi.advanceTimersByTime(550)
      await wrapper.vm.$nextTick()
      expect(poseOf(wrapper)).toBe('dwarf-pick-1')
    })

    it('holds a single-frame animation still', async () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ role: 'foreman', status: 'waiting' }) }
      })
      vi.advanceTimersByTime(10_000)
      await wrapper.vm.$nextTick()
      expect(poseOf(wrapper)).toBe('dwarf-foreman-idle')
    })

    it('restarts the cycle from the first frame when the status changes', async () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status: 'working' }) }
      })
      vi.advanceTimersByTime(550)
      await wrapper.vm.$nextTick()
      expect(poseOf(wrapper)).toBe('dwarf-pick-2')
      await wrapper.setProps({ dwarf: defaultDwarf({ status: 'waiting' }) })
      expect(poseOf(wrapper)).toBe('dwarf-rest-1')
    })

    it('stops its timer when unmounted', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status: 'working' }) }
      })
      wrapper.unmount()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
