/**
 * A deterministic AudioPlayer for tests, in the spirit of FakeFs
 * (src/main/adapters/fakeFs.ts): a hand-written fake rather than `vi.mock`,
 * because what the engine does to a clip is the behaviour under test and a
 * mock's call log is a poor way to ask "is the working bed audible right now".
 *
 * It records every clip ever opened, in order, and lets a test drive the two
 * things only the real element knows: how long a sound is, and where it has
 * got to. Nothing here has a timer — a ramp is remembered as an intent, and
 * `settleRamps()` is how a test says "two seconds later".
 *
 * It lives beside the player it fakes rather than in a test file, because both
 * the engine's suite and the composable's use it.
 */
import type { AudioClip, AudioPlayer } from './player'

export interface FakeAudioClip extends AudioClip {
  readonly src: string
  /** Whether `play()` has been called and neither `pause()` nor `stop()` since. */
  readonly playing: boolean
  readonly stopped: boolean
  readonly volume: number
  /** The ramp currently in flight, or undefined when the volume was cut. */
  readonly ramp: { to: number; ms: number } | undefined
  /** Pretend the sound is this long; `NaN` is the pre-metadata reading. */
  setDurationMs: (ms: number) => void
  /** Pretend the sound has got this far. */
  seekMs: (ms: number) => void
  /** Finish every ramp in flight, as if its time had passed. */
  settleRamp: () => void
  /** Fire the element's own `ended`, which is what drives the music gap. */
  end: () => void
}

export interface FakeAudioPlayer extends AudioPlayer {
  /** Every clip opened, oldest first — including the ones already stopped. */
  readonly clips: readonly FakeAudioClip[]
  /** The clips still open, which is what a test usually means by "playing". */
  live: () => readonly FakeAudioClip[]
  /** The live clips opened from `src`. */
  liveOf: (src: string) => readonly FakeAudioClip[]
  /** Finish every ramp in flight across every clip. */
  settleRamps: () => void
}

export function createFakeAudioPlayer(): FakeAudioPlayer {
  const clips: FakeAudioClip[] = []

  const player: FakeAudioPlayer = {
    clips,
    open(src, options) {
      let playing = false
      let stopped = false
      let volume = options?.volume ?? 0
      let ramp: { to: number; ms: number } | undefined
      let durationMs = Number.NaN
      let positionMs = 0

      const clip: FakeAudioClip = {
        src,
        get playing() {
          return playing
        },
        get stopped() {
          return stopped
        },
        get volume() {
          return volume
        },
        get ramp() {
          return ramp
        },
        play() {
          playing = true
        },
        pause() {
          playing = false
        },
        stop() {
          playing = false
          stopped = true
          ramp = undefined
        },
        setVolume(next) {
          volume = next
          ramp = undefined
        },
        rampVolume(next, ms) {
          ramp = { to: next, ms }
        },
        // The real player re-aims over what is LEFT of the ramp; the fake has
        // no clock, so it keeps the original length. Nothing asserts a
        // re-aimed length — only where the ramp is now headed.
        retargetVolume(next) {
          if (ramp === undefined) {
            volume = next
            return
          }
          ramp = { to: next, ms: ramp.ms }
        },
        positionMs: () => positionMs,
        durationMs: () => durationMs,
        setDurationMs(ms) {
          durationMs = ms
        },
        seekMs(ms) {
          positionMs = ms
        },
        settleRamp() {
          if (ramp === undefined) return
          volume = ramp.to
          ramp = undefined
        },
        end() {
          playing = false
          options?.onEnded?.()
        }
      }
      clips.push(clip)
      return clip
    },
    live: () => clips.filter((clip) => !clip.stopped),
    liveOf: (src) => clips.filter((clip) => !clip.stopped && clip.src === src),
    settleRamps() {
      for (const clip of clips) clip.settleRamp()
    }
  }

  return player
}
