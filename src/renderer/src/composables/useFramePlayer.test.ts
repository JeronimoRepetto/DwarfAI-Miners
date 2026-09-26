// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { createFrameClock, type FrameClockEnv } from '../lib/sprite/frameClock'
import { loopOf, type SequencePosition, type SpriteClip } from '../lib/sprite/spriteSheet'
import { FRAME_CLOCK_KEY, useFramePlayer } from './useFramePlayer'

const SWING = loopOf({ src: 'swing.png', frames: 3, frameMs: 100, durations: [120, 60, 200] })
const IDLE = loopOf({ src: 'idle.png', frames: 2, frameMs: 100, durations: [300, 300] })

/** A clock on hand-moved time, with its one timer visible. */
function manualClock(): {
  env: FrameClockEnv
  advance(ms: number): void
  timers(): number
} {
  let t = 0
  let seq = 0
  let timers: { id: number; at: number; run: () => void }[] = []
  const env: FrameClockEnv = {
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
    random: () => 0
  }
  return {
    env,
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
    },
    timers: () => timers.length
  }
}

function host(clips: Ref<readonly SpriteClip[]>, seen: { position?: Ref<SequencePosition> }) {
  return defineComponent({
    setup() {
      seen.position = useFramePlayer(() => clips.value, { phase: true })
      return () => h('span')
    }
  })
}

describe('useFramePlayer', () => {
  it('plays the clips on the clock the tree provides, frame by frame', async () => {
    const clock = manualClock()
    const clips = ref<readonly SpriteClip[]>([SWING])
    const seen: { position?: Ref<SequencePosition> } = {}
    mount(host(clips, seen), {
      global: { provide: { [FRAME_CLOCK_KEY as symbol]: createFrameClock(clock.env) } }
    })
    expect(seen.position!.value).toEqual({ clip: 0, frame: 0 })
    clock.advance(120)
    expect(seen.position!.value).toEqual({ clip: 0, frame: 1 })
  })

  it('swaps the sequence in place when the clips change', async () => {
    const clock = manualClock()
    const clips = ref<readonly SpriteClip[]>([SWING])
    const seen: { position?: Ref<SequencePosition> } = {}
    mount(host(clips, seen), {
      global: { provide: { [FRAME_CLOCK_KEY as symbol]: createFrameClock(clock.env) } }
    })
    clock.advance(130)
    clips.value = [IDLE]
    await nextTick()
    expect(seen.position!.value).toEqual({ clip: 0, frame: 0 })
    clock.advance(299)
    expect(seen.position!.value).toEqual({ clip: 0, frame: 0 })
    clock.advance(1)
    expect(seen.position!.value).toEqual({ clip: 0, frame: 1 })
  })

  it('shares one timer between every sprite of the tree, and lets go on unmount', () => {
    const clock = manualClock()
    const frameClock = createFrameClock(clock.env)
    const wrappers = [0, 1, 2].map(() =>
      mount(host(ref([SWING]), {}), {
        global: { provide: { [FRAME_CLOCK_KEY as symbol]: frameClock } }
      })
    )
    expect(clock.timers()).toBe(1)
    for (const wrapper of wrappers) wrapper.unmount()
    expect(clock.timers()).toBe(0)
  })
})
