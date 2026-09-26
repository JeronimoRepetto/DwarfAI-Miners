// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { FRAME_CLOCK_KEY } from '../../composables/useFramePlayer'
import {
  createFrameClock,
  stoppedFrameClock,
  type FrameClockEnv
} from '../../lib/sprite/frameClock'
import type { SpriteSheet } from '../../lib/sprite/spriteSheet'
import SpriteStrip from './SpriteStrip.vue'

const SWING: SpriteSheet = { src: '/swing.png', frames: 3, frameMs: 100, durations: [120, 60, 200] }

function manualClock(random = 0): { env: FrameClockEnv; advance(ms: number): void } {
  let t = 0
  let seq = 0
  let timers: { id: number; at: number; run: () => void }[] = []
  return {
    env: {
      now: () => t,
      setTimer: (run, ms) => {
        timers.push({ id: ++seq, at: t + ms, run })
        return seq
      },
      clearTimer: (id) => {
        timers = timers.filter((timer) => timer.id !== id)
      },
      hidden: () => false,
      onVisibilityChange: () => () => {},
      reducedMotion: () => false,
      onReducedMotionChange: () => () => {},
      random: () => random
    },
    advance(ms) {
      const target = t + ms
      for (;;) {
        const next = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0]
        if (next === undefined) break
        t = next.at
        timers = timers.filter((timer) => timer.id !== next.id)
        next.run()
      }
      t = target
    }
  }
}

function mountStrip(props: Record<string, unknown>, clock = stoppedFrameClock()) {
  return mount(SpriteStrip, {
    props: { sheet: SWING, ...props },
    global: { provide: { [FRAME_CLOCK_KEY as symbol]: clock } }
  })
}

const offsetOf = (wrapper: ReturnType<typeof mountStrip>): string =>
  wrapper.find('img').attributes('style') ?? ''

describe('SpriteStrip', () => {
  it('is a clipping box one cell wide, holding the whole strip as one image', () => {
    // components.md, Sprite, Anatomy: a box one cell wide (36x38), the strip moved by whole cells.
    const wrapper = mountStrip({})
    const root = wrapper.find('span.dm-sprite')
    expect(root.attributes('style')).toContain('width: 36px')
    expect(root.attributes('style')).toContain('height: 38px')
    const img = wrapper.find('img.dm-sprite__strip')
    expect(img.attributes('src')).toBe('/swing.png')
    expect(img.attributes('style')).toContain('width: 108px')
    expect(img.attributes('style')).toContain('height: 38px')
  })

  it('scales by a whole number, cell and strip together', () => {
    const wrapper = mountStrip({ scale: 2 })
    expect(wrapper.find('span.dm-sprite').attributes('style')).toContain('width: 72px')
    expect(wrapper.find('img').attributes('style')).toContain('width: 216px')
  })

  it('is hidden from assistive technology: the dwarf’s button or name carries meaning', () => {
    const wrapper = mountStrip({})
    expect(wrapper.find('span.dm-sprite').attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('img').attributes('alt')).toBe('')
  })

  it('mirrors for a dwarf facing right, the sheets being painted facing left', () => {
    expect(mountStrip({ flip: true }).classes()).toContain('dm-sprite--flip')
    expect(mountStrip({}).classes()).not.toContain('dm-sprite--flip')
  })

  it('advances the strip by whole cells on the shared clock, each frame its own duration', () => {
    const clock = manualClock()
    const wrapper = mountStrip({ scale: 2 }, createFrameClock(clock.env))
    expect(offsetOf(wrapper)).toContain('translateX(0px)')
    clock.advance(120)
    return wrapper.vm.$nextTick().then(() => {
      expect(offsetOf(wrapper)).toContain('translateX(-72px)')
      clock.advance(60)
      return wrapper.vm.$nextTick().then(() => {
        expect(offsetOf(wrapper)).toContain('translateX(-144px)')
      })
    })
  })

  it('starts a looping sheet on its phase frame', () => {
    const clock = manualClock(0.5)
    const wrapper = mountStrip({}, createFrameClock(clock.env))
    // k = round(0.5 x 3) = 2.
    expect(offsetOf(wrapper)).toContain('translateX(-72px)')
  })

  it('plays a one-shot sheet from frame 0 and holds its last frame', async () => {
    const clock = manualClock(0.5)
    const wrapper = mountStrip({ once: true }, createFrameClock(clock.env))
    expect(offsetOf(wrapper)).toContain('translateX(0px)')
    clock.advance(10_000)
    await wrapper.vm.$nextTick()
    expect(offsetOf(wrapper)).toContain('translateX(-72px)')
  })

  it('holds frame 0 for the still option, a static picture that never plays', async () => {
    const clock = manualClock(0.5)
    const wrapper = mountStrip({ still: true }, createFrameClock(clock.env))
    clock.advance(10_000)
    await wrapper.vm.$nextTick()
    expect(offsetOf(wrapper)).toContain('translateX(0px)')
    expect(wrapper.classes()).toContain('dm-sprite--still')
  })

  it('swaps the sheet in place, keeping the same element', async () => {
    const wrapper = mountStrip({})
    const img = wrapper.find('img').element
    await wrapper.setProps({ sheet: { ...SWING, src: '/idle.png' } })
    expect(wrapper.find('img').element).toBe(img)
    expect(wrapper.find('img').attributes('src')).toBe('/idle.png')
  })
})
