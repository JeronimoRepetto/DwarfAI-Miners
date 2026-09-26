/**
 * The one frame clock every sprite plays on (#635).
 *
 * The design's rule for any mode that is working (motion.md, "Sprites and idle cost"): sprites run
 * on ONE shared frame clock that advances each sheet by its own per-frame durations; a status
 * change swaps the sheet in place; there is no per-sprite timer, and nothing ticks while the window
 * is hidden. CSS steps() cannot give one frame its own length, which is why this is JavaScript at
 * all (decision log, Sprite frame clock).
 *
 * So there is exactly one timer, set to the EARLIEST next frame change among every playing sprite
 * — never a 60Hz requestAnimationFrame loop, which would wake a panel of idle dwarfs sixty times a
 * second to change nothing. A crew of breathing dwarfs wakes the renderer a few times a second, and
 * a panel where nothing moves holds no timer at all.
 *
 * Time here is SPRITE time: the environment's clock with every hidden stretch taken out, so a
 * dwarf resumes on the frame it stood on when the window went away rather than jumping to wherever
 * the wall clock would have carried it. Under reduced motion every frame of every sheet lasts a
 * flat 200ms (motion.md, Reduced motion): the dwarfs keep moving, and a change of the preference
 * mid-play keeps each sprite on the frame it is showing.
 *
 * Everything the clock touches outside itself comes through `FrameClockEnv`, which is what lets
 * the tests run it on a fake clock and the golden page on one stopped at t = 0.
 */
import { prefersReducedMotion, watchReducedMotion } from '../scene/sceneMotion'
import {
  REDUCED_MOTION_FRAME_MS,
  sequenceFrameAt,
  sequenceNextChangeMs,
  sequenceOffsetMs,
  type SequencePosition,
  type SpriteClip
} from './spriteSheet'

/** What the clock needs from its host: a clock, one timer, visibility, the motion preference. */
export interface FrameClockEnv {
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  hidden(): boolean
  onVisibilityChange(listener: () => void): () => void
  reducedMotion(): boolean
  onReducedMotionChange(listener: (reduced: boolean) => void): () => void
  /** Chooses each looping sprite's phase; `Math.random` in the app. */
  random(): number
}

export interface PlayOptions {
  /**
   * Start a lone looping sheet on a random whole frame k, so a crew never swings in lockstep
   * (components.md, Sprite, Anatomy: k = round(random x frames), and k = frames is frame 0). A
   * sequence led by a transition, or made of several clips, always starts on frame 0.
   */
  readonly phase?: boolean
}

/** One sprite on the clock. */
export interface FramePlayer {
  /** Plays a sequence from its start (or its phase frame), replacing whatever was playing. */
  play(clips: readonly SpriteClip[], options?: PlayOptions): void
  /** Takes the sprite off the clock; `play` puts it back. */
  stop(): void
}

export interface FrameClock {
  /** A sprite that is told every frame it should show, the first at once. */
  player(onFrame: (position: SequencePosition) => void): FramePlayer
  /** Lets go of the host: no timer, no listener. */
  dispose(): void
}

interface Track {
  clips: readonly SpriteClip[]
  /** The sprite time at which the sequence's elapsed time was zero. */
  anchor: number
  position: SequencePosition
  /** The sprite time of the next change, or undefined where nothing will change again. */
  due: number | undefined
  onFrame: (position: SequencePosition) => void
}

function samePosition(a: SequencePosition, b: SequencePosition): boolean {
  return a.clip === b.clip && a.frame === b.frame
}

export function createFrameClock(env: FrameClockEnv): FrameClock {
  const tracks = new Set<Track>()
  let reduced = env.reducedMotion()
  let hiddenSince: number | undefined = env.hidden() ? env.now() : undefined
  let hiddenTotal = 0
  let timer: unknown
  let timerAt: number | undefined
  let disposed = false

  const flat = (): number | undefined => (reduced ? REDUCED_MOTION_FRAME_MS : undefined)
  const spriteNow = (): number => (hiddenSince ?? env.now()) - hiddenTotal

  function clearTimer(): void {
    if (timerAt === undefined) return
    env.clearTimer(timer)
    timer = undefined
    timerAt = undefined
  }

  function dueAfter(track: Track, now: number): number | undefined {
    const next = sequenceNextChangeMs(track.clips, now - track.anchor, flat())
    return next === undefined ? undefined : now + next
  }

  // One timer, set to the earliest change; none while hidden or while nothing will change.
  function schedule(): void {
    if (disposed || hiddenSince !== undefined) {
      clearTimer()
      return
    }
    let earliest: number | undefined
    for (const track of tracks) {
      if (track.due !== undefined && (earliest === undefined || track.due < earliest)) {
        earliest = track.due
      }
    }
    if (earliest === undefined) {
      clearTimer()
      return
    }
    // Always set afresh rather than keeping a timer already aimed at the same moment: a host that
    // dropped a timer behind the clock's back (a test's fake timers torn down) must not strand it.
    clearTimer()
    timerAt = earliest
    timer = env.setTimer(tick, Math.max(0, earliest - spriteNow()))
  }

  function tick(): void {
    timer = undefined
    timerAt = undefined
    const now = spriteNow()
    for (const track of tracks) {
      if (track.due === undefined || track.due > now) continue
      const position = sequenceFrameAt(track.clips, now - track.anchor, flat())
      track.due = dueAfter(track, now)
      if (!samePosition(position, track.position)) {
        track.position = position
        track.onFrame(position)
      }
    }
    schedule()
  }

  function onVisibility(): void {
    const hidden = env.hidden()
    if (hidden && hiddenSince === undefined) {
      hiddenSince = env.now()
    } else if (!hidden && hiddenSince !== undefined) {
      hiddenTotal += env.now() - hiddenSince
      hiddenSince = undefined
    }
    schedule()
  }

  // A new timing keeps every sprite on the frame it shows, starting that frame's hold afresh.
  function applyReduced(next: boolean): void {
    if (next === reduced) return
    reduced = next
    const now = spriteNow()
    for (const track of tracks) {
      track.anchor = now - sequenceOffsetMs(track.clips, track.position, flat())
      track.due = dueAfter(track, now)
    }
  }

  /*
   * The host's events are listened to only while a sprite plays, not from the clock's making: a
   * clock with nothing on it has nothing to keep awake for, and a media query or document the host
   * swaps in before a sprite plays (a test stubbing matchMedia) must still be the one heard.
   */
  let stopListening: (() => void) | undefined
  function listen(): void {
    if (stopListening !== undefined) return
    const stopVisibility = env.onVisibilityChange(onVisibility)
    const stopReduced = env.onReducedMotionChange((next) => {
      applyReduced(next)
      schedule()
    })
    stopListening = () => {
      stopVisibility()
      stopReduced()
    }
    onVisibility()
  }

  function startOffset(clips: readonly SpriteClip[], options: PlayOptions | undefined): number {
    const only = clips[0]
    if (options?.phase !== true || clips.length !== 1 || only?.playback !== 'loop') return 0
    const frames = only.sheet.frames
    if (frames < 2) return 0
    const k = Math.round(env.random() * frames) % frames
    return sequenceOffsetMs(clips, { clip: 0, frame: k }, flat())
  }

  return {
    player(onFrame) {
      const track: Track = {
        clips: [],
        anchor: 0,
        position: { clip: 0, frame: 0 },
        due: undefined,
        onFrame
      }
      return {
        play(clips, options) {
          if (disposed) return
          listen()
          // Read the preference again here as well as on its change event: a query replaced
          // since the clock began listening sends it no event.
          applyReduced(env.reducedMotion())
          const now = spriteNow()
          const offset = startOffset(clips, options)
          track.clips = clips
          track.anchor = now - offset
          track.position = sequenceFrameAt(clips, offset, flat())
          track.due = dueAfter(track, now)
          tracks.add(track)
          onFrame(track.position)
          schedule()
        },
        stop() {
          tracks.delete(track)
          if (tracks.size === 0) {
            stopListening?.()
            stopListening = undefined
          }
          schedule()
        }
      }
    },
    dispose() {
      disposed = true
      tracks.clear()
      clearTimer()
      stopListening?.()
    }
  }
}

/**
 * A clock stopped at t = 0: every sprite shows frame 0 of what it plays and never changes, and no
 * phase is drawn. The golden page plays on it, because every reference image holds every sprite on
 * frame 0 (components.md, Sprite, Anatomy).
 */
export function stoppedFrameClock(): FrameClock {
  const never = (): (() => void) => () => {}
  return createFrameClock({
    now: () => 0,
    setTimer: () => undefined,
    clearTimer: () => {},
    hidden: () => false,
    onVisibilityChange: never,
    reducedMotion: () => false,
    onReducedMotionChange: never,
    random: () => 0
  })
}

/**
 * The window as the clock's host: its wall clock and timer, the document's visibility, the
 * reduced-motion media query, and Math.random for the phase. Every call reaches the global at the
 * moment it is made, never a reference kept from before, so a test's fake timers are the timers.
 */
export function browserFrameClockEnv(): FrameClockEnv {
  const doc = (): Document | undefined => globalThis.document
  return {
    now: () => Date.now(),
    setTimer: (run, ms) => globalThis.setTimeout(run, ms),
    clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    hidden: () => doc()?.hidden === true,
    onVisibilityChange(listener) {
      const target = doc()
      if (target === undefined) return () => {}
      target.addEventListener('visibilitychange', listener)
      return () => target.removeEventListener('visibilitychange', listener)
    },
    reducedMotion: () => prefersReducedMotion(),
    onReducedMotionChange: (listener) => watchReducedMotion(listener),
    random: () => Math.random()
  }
}
