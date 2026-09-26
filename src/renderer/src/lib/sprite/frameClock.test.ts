import { describe, expect, it } from 'vitest'
import { createFrameClock, stoppedFrameClock, type FrameClockEnv } from './frameClock'
import { loopOf, onceOf, type SequencePosition, type SpriteSheet } from './spriteSheet'

/** A three-frame swing with the shape of the pick: 120ms, a hurried 60ms, the impact held 200ms. */
const SWING: SpriteSheet = { src: 'swing.png', frames: 3, frameMs: 100, durations: [120, 60, 200] }
/** A six-frame idle breathing at the sidecar's own pace. */
const IDLE: SpriteSheet = {
  src: 'idle.png',
  frames: 6,
  frameMs: 100,
  durations: [200, 180, 180, 260, 140, 160]
}
/** A two-frame transition played once before a loop. */
const START: SpriteSheet = { src: 'start.png', frames: 2, frameMs: 100, durations: [150, 50] }

/*
 * A hand-written environment in place of the window (the house idiom: fakes, not vi.mock). Time is
 * a number the test moves; timers are a list the test can count, which is the whole point of the
 * clock — one timer for every sprite, set to the earliest frame change.
 */
function fakeEnv(): FrameClockEnv & {
  t: number
  isHidden: boolean
  reduced: boolean
  rnd: number
  timers: { id: number; at: number; run: () => void }[]
  fired: number
  advance(ms: number): void
  setHidden(hidden: boolean): void
  setReduced(reduced: boolean): void
} {
  let seq = 0
  const visibility = new Set<() => void>()
  const reducedListeners = new Set<(reduced: boolean) => void>()
  const env = {
    t: 0,
    isHidden: false,
    reduced: false,
    rnd: 0,
    timers: [] as { id: number; at: number; run: () => void }[],
    fired: 0,
    now: () => env.t,
    setTimer(run: () => void, ms: number) {
      const id = ++seq
      env.timers.push({ id, at: env.t + Math.max(0, ms), run })
      return id
    },
    clearTimer(handle: unknown) {
      env.timers = env.timers.filter((timer) => timer.id !== handle)
    },
    hidden: () => env.isHidden,
    onVisibilityChange(listener: () => void) {
      visibility.add(listener)
      return () => visibility.delete(listener)
    },
    reducedMotion: () => env.reduced,
    onReducedMotionChange(listener: (reduced: boolean) => void) {
      reducedListeners.add(listener)
      return () => reducedListeners.delete(listener)
    },
    random: () => env.rnd,
    advance(ms: number) {
      const target = env.t + ms
      for (;;) {
        const due = env.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)
        const next = due[0]
        if (next === undefined) break
        env.t = next.at
        env.timers = env.timers.filter((timer) => timer.id !== next.id)
        env.fired++
        next.run()
      }
      env.t = target
    },
    setHidden(hidden: boolean) {
      env.isHidden = hidden
      for (const listener of visibility) listener()
    },
    setReduced(reduced: boolean) {
      env.reduced = reduced
      for (const listener of reducedListeners) listener(reduced)
    }
  }
  return env
}

function recorder(): { frames: SequencePosition[]; onFrame: (p: SequencePosition) => void } {
  const frames: SequencePosition[] = []
  return { frames, onFrame: (position) => frames.push(position) }
}

const at = (frame: number, clip = 0): SequencePosition => ({ clip, frame })

describe('createFrameClock', () => {
  it('shows the first frame at once and plays each frame for its own duration', () => {
    const env = fakeEnv()
    const clock = createFrameClock(env)
    const { frames, onFrame } = recorder()
    clock.player(onFrame).play([loopOf(SWING)])
    expect(frames).toEqual([at(0)])

    env.advance(119)
    expect(frames).toEqual([at(0)])
    env.advance(1)
    expect(frames).toEqual([at(0), at(1)])
    env.advance(60)
    expect(frames).toEqual([at(0), at(1), at(2)])
    env.advance(200)
    expect(frames).toEqual([at(0), at(1), at(2), at(0)])
  })

  it('wakes only when a frame changes, never at a fixed rate', () => {
    // Three frames a lap, ten laps: thirty wake-ups and not one more. A 60Hz loop would have
    // woken about 228 times over the same 3.8s.
    const env = fakeEnv()
    createFrameClock(env)
      .player(() => {})
      .play([loopOf(SWING)])
    env.advance(3800)
    expect(env.fired).toBe(30)
  })

  it('drives every sprite from one timer, set to the earliest next change', () => {
    const env = fakeEnv()
    const clock = createFrameClock(env)
    const swing = recorder()
    const idle = recorder()
    clock.player(swing.onFrame).play([loopOf(SWING)])
    clock.player(idle.onFrame).play([loopOf(IDLE)])
    expect(env.timers).toHaveLength(1)
    expect(env.timers[0]!.at).toBe(120)

    env.advance(120)
    // The swing moved; the idle, due at 200, did not.
    expect(swing.frames.at(-1)).toEqual(at(1))
    expect(idle.frames).toEqual([at(0)])
    expect(env.timers).toHaveLength(1)
    expect(env.timers[0]!.at).toBe(180)

    env.advance(80)
    expect(idle.frames).toEqual([at(0), at(1)])
    expect(env.timers).toHaveLength(1)
  })

  it('jumps to the right frame when a wake-up comes late', () => {
    const env = fakeEnv()
    const clock = createFrameClock(env)
    const { frames, onFrame } = recorder()
    clock.player(onFrame).play([loopOf(SWING)])
    // The timer was due at 120 but the host only ran it at 250: frame 2 is what shows by then.
    env.timers[0]!.at = 250
    env.advance(250)
    expect(frames).toEqual([at(0), at(2)])
    expect(env.timers[0]!.at).toBe(380)
  })

  it('plays a transition once and then its loop, and stops waking once nothing will change', () => {
    const env = fakeEnv()
    const clock = createFrameClock(env)
    const { frames, onFrame } = recorder()
    clock.player(onFrame).play([onceOf(START), loopOf(SWING)])
    env.advance(200)
    expect(frames).toEqual([at(0), at(1), at(0, 1)])

    const settled = recorder()
    clock.player(settled.onFrame).play([onceOf(START)])
    env.advance(200)
    expect(settled.frames).toEqual([at(0), at(1)])
    // Only the looping sprite still needs a timer.
    clock.player(() => {}).stop()
    expect(env.timers).toHaveLength(1)
  })

  it('swaps a sprite’s sequence in place and restarts it', () => {
    const env = fakeEnv()
    const clock = createFrameClock(env)
    const { frames, onFrame } = recorder()
    const player = clock.player(onFrame)
    player.play([loopOf(SWING)])
    env.advance(130)
    player.play([loopOf(IDLE)])
    expect(frames).toEqual([at(0), at(1), at(0)])
    expect(env.timers).toHaveLength(1)
    expect(env.timers[0]!.at).toBe(130 + 200)
  })

  it('holds no timer at all once every sprite has stopped', () => {
    const env = fakeEnv()
    const clock = createFrameClock(env)
    const a = clock.player(() => {})
    const b = clock.player(() => {})
    a.play([loopOf(SWING)])
    b.play([loopOf(IDLE)])
    a.stop()
    expect(env.timers).toHaveLength(1)
    b.stop()
    expect(env.timers).toHaveLength(0)
    env.advance(10_000)
    expect(env.fired).toBe(0)
  })

  describe('while the window is hidden', () => {
    it('ticks nothing, and resumes where it stood when the window shows again', () => {
      const env = fakeEnv()
      const clock = createFrameClock(env)
      const { frames, onFrame } = recorder()
      clock.player(onFrame).play([loopOf(SWING)])
      env.advance(100)
      env.setHidden(true)
      expect(env.timers).toHaveLength(0)

      env.advance(60_000)
      expect(frames).toEqual([at(0)])
      expect(env.fired).toBe(0)

      env.setHidden(false)
      // 20ms of frame 0's hold were left when the window went away, and they still are.
      expect(env.timers).toHaveLength(1)
      env.advance(19)
      expect(frames).toEqual([at(0)])
      env.advance(1)
      expect(frames).toEqual([at(0), at(1)])
    })

    it('starts a sprite added while hidden without scheduling anything for it', () => {
      const env = fakeEnv()
      env.isHidden = true
      const clock = createFrameClock(env)
      const { frames, onFrame } = recorder()
      clock.player(onFrame).play([loopOf(SWING)])
      expect(frames).toEqual([at(0)])
      expect(env.timers).toHaveLength(0)
      env.setHidden(false)
      env.advance(120)
      expect(frames).toEqual([at(0), at(1)])
    })
  })

  describe('under reduced motion', () => {
    it('keeps playing, every frame a flat 200ms, the durations replaced and not scaled', () => {
      const env = fakeEnv()
      env.reduced = true
      const clock = createFrameClock(env)
      const { frames, onFrame } = recorder()
      clock.player(onFrame).play([loopOf(SWING)])
      env.advance(199)
      expect(frames).toEqual([at(0)])
      env.advance(1)
      expect(frames).toEqual([at(0), at(1)])
      env.advance(400)
      // Three frames, 600ms a lap.
      expect(frames).toEqual([at(0), at(1), at(2), at(0)])
    })

    it('reacts to the preference changing, keeping the frame it is on', () => {
      const env = fakeEnv()
      const clock = createFrameClock(env)
      const { frames, onFrame } = recorder()
      clock.player(onFrame).play([loopOf(SWING)])
      env.advance(130)
      expect(frames.at(-1)).toEqual(at(1))

      env.setReduced(true)
      // Frame 1 starts over at 200ms rather than its own 60ms.
      expect(frames.at(-1)).toEqual(at(1))
      env.advance(199)
      expect(frames.at(-1)).toEqual(at(1))
      env.advance(1)
      expect(frames.at(-1)).toEqual(at(2))

      env.setReduced(false)
      env.advance(199)
      expect(frames.at(-1)).toEqual(at(2))
      env.advance(1)
      expect(frames.at(-1)).toEqual(at(0))
    })
  })

  describe('the phase', () => {
    it('starts a looping sheet on a random whole frame, so a crew never swings in lockstep', () => {
      // components.md, Sprite, Anatomy: k = round(random x frames), and k = frames is frame 0.
      const env = fakeEnv()
      const clock = createFrameClock(env)
      for (const [rnd, frame] of [
        [0, 0],
        [0.5, 3],
        [0.62, 4],
        [0.99, 0]
      ] as const) {
        env.rnd = rnd
        const { frames, onFrame } = recorder()
        clock.player(onFrame).play([loopOf(IDLE)], { phase: true })
        expect(frames, String(rnd)).toEqual([at(frame)])
      }
    })

    it('then plays that frame for its own full hold', () => {
      const env = fakeEnv()
      env.rnd = 0.5
      const clock = createFrameClock(env)
      const { frames, onFrame } = recorder()
      clock.player(onFrame).play([loopOf(IDLE)], { phase: true })
      env.advance(259)
      expect(frames).toEqual([at(3)])
      env.advance(1)
      expect(frames).toEqual([at(3), at(4)])
    })

    it('always starts a transition on frame 0', () => {
      const env = fakeEnv()
      env.rnd = 0.5
      const clock = createFrameClock(env)
      const { frames, onFrame } = recorder()
      clock.player(onFrame).play([onceOf(START), loopOf(SWING)], { phase: true })
      expect(frames).toEqual([at(0)])
    })
  })

  it('lets go of the window when disposed', () => {
    const env = fakeEnv()
    const clock = createFrameClock(env)
    clock.player(() => {}).play([loopOf(SWING)])
    clock.dispose()
    expect(env.timers).toHaveLength(0)
    env.setHidden(true)
    env.setHidden(false)
    expect(env.timers).toHaveLength(0)
  })
})

describe('stoppedFrameClock', () => {
  it('holds every sprite on frame 0 and never schedules a change', () => {
    // What the golden page uses: every reference image holds every sprite on frame 0
    // (components.md, Sprite, Anatomy), whatever its phase.
    const clock = stoppedFrameClock()
    const { frames, onFrame } = recorder()
    clock.player(onFrame).play([loopOf(IDLE)], { phase: true })
    expect(frames).toEqual([at(0)])
  })
})

describe('createFrameClock and a preference it was never told about', () => {
  it('reads the preference again whenever a sprite starts', () => {
    // A media query replaced since the clock was made sends it no change event; the next sprite
    // to start still plays by the preference as it stands.
    const env = fakeEnv()
    const clock = createFrameClock(env)
    env.reduced = true
    const { frames, onFrame } = recorder()
    clock.player(onFrame).play([loopOf(SWING)])
    env.advance(199)
    expect(frames).toEqual([at(0)])
    env.advance(1)
    expect(frames).toEqual([at(0), at(1)])
  })
})
