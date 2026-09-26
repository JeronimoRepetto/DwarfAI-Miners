/**
 * A component's sprite on the one shared frame clock (#635).
 *
 * Every sprite in a window plays on the same clock (motion.md, "Any mode, working": no per-sprite
 * timer), so the clock is the window's, not the component's: a tree may provide one under
 * `FRAME_CLOCK_KEY` — the golden page provides a clock stopped at t = 0 — and every other sprite
 * shares the one this module makes on first use for the window it runs in.
 */
import { inject, onBeforeUnmount, shallowRef, watch, type InjectionKey, type Ref } from 'vue'
import {
  browserFrameClockEnv,
  createFrameClock,
  type FrameClock,
  type PlayOptions
} from '../lib/sprite/frameClock'
import type { SequencePosition, SpriteClip } from '../lib/sprite/spriteSheet'

export const FRAME_CLOCK_KEY: InjectionKey<FrameClock> = Symbol('frame-clock')

let shared: FrameClock | undefined

/** The window's own clock, made once, on the first sprite that asks for it. */
export function sharedFrameClock(): FrameClock {
  shared ??= createFrameClock(browserFrameClockEnv())
  return shared
}

/**
 * The frame to show for `clips`, kept current by the clock. A new sequence swaps in place and
 * starts over (on its phase frame, where `options.phase` asks for one); unmounting takes the
 * sprite off the clock.
 */
export function useFramePlayer(
  clips: () => readonly SpriteClip[],
  options: PlayOptions = {}
): Ref<SequencePosition> {
  const clock = inject(FRAME_CLOCK_KEY, null) ?? sharedFrameClock()
  const position = shallowRef<SequencePosition>({ clip: 0, frame: 0 })
  const player = clock.player((next) => {
    position.value = next
  })
  watch(clips, (next) => player.play(next, options), { immediate: true })
  onBeforeUnmount(() => player.stop())
  return position
}
