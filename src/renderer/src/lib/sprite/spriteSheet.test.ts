import { describe, expect, it } from 'vitest'
import type { SpriteSheet } from './spriteSheet'
import {
  SPRITE_FRAME_SIZE,
  backgroundSizePercent,
  framePositionPercent,
  isGlowFrame,
  isImpactFrame,
  loopOf,
  onceOf,
  sequenceCycle,
  sequenceDurationMs,
  sequenceFrameAt,
  sequenceIsStill
} from './spriteSheet'

/** A six-frame strip, the shape the worker's idle sheet actually ships as. */
const SIX: SpriteSheet = { src: 'six.png', frames: 6, frameMs: 100 }
/** A three-frame strip, small enough to step through by hand in a test. */
const THREE: SpriteSheet = { src: 'three.png', frames: 3, frameMs: 200 }
/** The degenerate strip: one frame, which is a still picture wearing a sheet. */
const ONE: SpriteSheet = { src: 'one.png', frames: 1, frameMs: 100 }

describe('SPRITE_FRAME_SIZE', () => {
  it('is the box the hand-drawn dwarf frames are actually authored in', () => {
    // Measured off the PNG headers of every committed *-Sheet.png, not taken
    // from the design source, which says 34x36 (see dwarfSheets.test.ts).
    expect(SPRITE_FRAME_SIZE).toEqual({ width: 36, height: 38 })
  })
})

describe('framePositionPercent', () => {
  /*
   * The one piece of arithmetic the whole mechanism rests on. A percentage in
   * `background-position` resolves against (box - image), so with the image
   * sized to N boxes wide the travel is (N-1) boxes and frame i sits at
   * i/(N-1) of it. Getting this wrong shows half of two frames at once.
   */
  it('puts the first frame at the left edge and the last at the right', () => {
    expect(framePositionPercent(0, 6)).toBe(0)
    expect(framePositionPercent(5, 6)).toBe(100)
  })

  it('spaces the frames between evenly', () => {
    expect(framePositionPercent(1, 3)).toBe(50)
    expect(framePositionPercent(1, 5)).toBe(25)
    expect(framePositionPercent(3, 5)).toBe(75)
  })

  it('parks a single-frame strip at zero rather than dividing by nothing', () => {
    // (N-1) is the travel, and a one-frame strip has none. Any percentage of
    // zero is zero, so the answer is only ever wrong if it is NaN.
    expect(framePositionPercent(0, 1)).toBe(0)
    expect(framePositionPercent(3, 1)).toBe(0)
  })

  it('never walks off either end of the strip', () => {
    expect(framePositionPercent(-2, 6)).toBe(0)
    expect(framePositionPercent(99, 6)).toBe(100)
  })
})

describe('backgroundSizePercent', () => {
  it('stretches the strip to one box per frame, which is what the position assumes', () => {
    expect(backgroundSizePercent(SIX)).toBe(600)
    expect(backgroundSizePercent(ONE)).toBe(100)
  })
})

describe('sequenceFrameAt', () => {
  /*
   * The frame-for-time function, pure so the cadence can be tested without a
   * fake clock at all: the component owns the interval, this owns the answer.
   */
  it('holds the first frame before any time has passed', () => {
    expect(sequenceFrameAt([loopOf(SIX)], 0)).toEqual({ clip: 0, frame: 0 })
  })

  it('steps one frame per frameMs', () => {
    expect(sequenceFrameAt([loopOf(THREE)], 200)).toEqual({ clip: 0, frame: 1 })
    expect(sequenceFrameAt([loopOf(THREE)], 400)).toEqual({ clip: 0, frame: 2 })
  })

  it('holds a frame for its whole hold, changing only on the boundary', () => {
    expect(sequenceFrameAt([loopOf(THREE)], 199)).toEqual({ clip: 0, frame: 0 })
    expect(sequenceFrameAt([loopOf(THREE)], 200)).toEqual({ clip: 0, frame: 1 })
  })

  it('wraps a looping clip round for ever', () => {
    expect(sequenceFrameAt([loopOf(THREE)], 600)).toEqual({ clip: 0, frame: 0 })
    expect(sequenceFrameAt([loopOf(THREE)], 60_000)).toEqual({ clip: 0, frame: 0 })
  })

  it('hands a once-clip on to the clip behind it when it has played out', () => {
    // Falling asleep is played once and then the sleep loop takes over; the
    // handover is what makes the two sheets read as one movement.
    const clips = [onceOf(THREE), loopOf(SIX)]
    expect(sequenceFrameAt(clips, 400)).toEqual({ clip: 0, frame: 2 })
    expect(sequenceFrameAt(clips, 600)).toEqual({ clip: 1, frame: 0 })
    expect(sequenceFrameAt(clips, 700)).toEqual({ clip: 1, frame: 1 })
  })

  it('holds the last frame of a trailing once-clip rather than looping it', () => {
    // Nothing follows, so the drawing stops where the gesture ended. Looping
    // it would replay a transition as though it were an idle.
    expect(sequenceFrameAt([onceOf(THREE)], 600)).toEqual({ clip: 0, frame: 2 })
    expect(sequenceFrameAt([onceOf(THREE)], 60_000)).toEqual({ clip: 0, frame: 2 })
  })

  /*
   * AMENDED for #325. This case ran `[loopOf(THREE), loopOf(SIX)]` and claimed
   * nothing behind a looping clip is ever reached. Consecutive loops are now
   * ONE cycle, and the clip behind the first is reached on every lap of it (the
   * block below pins that), so the claim moves to what it was actually
   * protecting: the settled cycle never runs out, so a `once` clip behind it is
   * unreachable. The old assertion would in fact still have passed, by
   * arithmetic accident — 60_000ms is a whole number of the two clips' 1200ms
   * laps, landing back on the first frame of the first clip — which is exactly
   * why it is restated here rather than left standing as evidence of anything.
   */
  it('never runs the settled cycle out, so nothing behind it is ever reached', () => {
    const clips = [loopOf(THREE), onceOf(SIX)]
    for (const elapsed of [60_000, 60_200, 60_400]) {
      expect(sequenceFrameAt(clips, elapsed).clip, String(elapsed)).toBe(0)
    }
  })

  it('treats time before the start as the start', () => {
    expect(sequenceFrameAt([loopOf(THREE)], -500)).toEqual({ clip: 0, frame: 0 })
  })

  it('answers an empty sequence rather than throwing', () => {
    expect(sequenceFrameAt([], 1000)).toEqual({ clip: 0, frame: 0 })
  })
})

/*
 * A CYCLE of clips (issue #325). A dwarf's shift is a pick-up, two turns of the
 * swing and a set-down, played round and round — four strips that are one
 * repeating movement, not a loop with a wind-up in front of it. Consecutive
 * `loop` clips are that movement: the cycle is as long as their holds add up
 * to, and the position inside it picks the clip as well as the frame.
 *
 * THREE is 600ms and SIX is 600ms, so the pair below is a 1200ms cycle with the
 * boundary exactly halfway — the arithmetic is small enough to step by hand.
 */
describe('sequenceFrameAt across a cycle of clips (#325)', () => {
  const CYCLE = [loopOf(THREE), loopOf(SIX)]

  it('plays the first clip of the cycle first', () => {
    expect(sequenceFrameAt(CYCLE, 0)).toEqual({ clip: 0, frame: 0 })
    expect(sequenceFrameAt(CYCLE, 400)).toEqual({ clip: 0, frame: 2 })
  })

  it('crosses the boundary into the next clip of the cycle', () => {
    // The move a lone looping clip could never make: the first clip plays out
    // and the second takes over WITHOUT the sequence having settled anywhere.
    expect(sequenceFrameAt(CYCLE, 600)).toEqual({ clip: 1, frame: 0 })
    expect(sequenceFrameAt(CYCLE, 700)).toEqual({ clip: 1, frame: 1 })
    expect(sequenceFrameAt(CYCLE, 1100)).toEqual({ clip: 1, frame: 5 })
  })

  it('wraps round to the head of the cycle, not to the clip it was on', () => {
    // What makes it a shift rather than a loop: the last clip hands back to
    // the FIRST, so the pick is picked up again.
    expect(sequenceFrameAt(CYCLE, 1200)).toEqual({ clip: 0, frame: 0 })
    expect(sequenceFrameAt(CYCLE, 1600)).toEqual({ clip: 0, frame: 2 })
    expect(sequenceFrameAt(CYCLE, 1800)).toEqual({ clip: 1, frame: 0 })
    expect(sequenceFrameAt(CYCLE, 60_000)).toEqual({ clip: 0, frame: 0 })
  })

  it('leaves a lone looping clip exactly what it always was', () => {
    // A cycle of one clip is the old behaviour by construction, which is what
    // keeps every sequence written before this one — idle, sleeping — unmoved.
    for (const elapsed of [0, 199, 200, 600, 700, 60_000]) {
      expect(sequenceFrameAt([loopOf(THREE)], elapsed), String(elapsed)).toEqual(
        sequenceFrameAt([loopOf(THREE)], elapsed % 600)
      )
    }
    expect(sequenceFrameAt([loopOf(THREE)], 700)).toEqual({ clip: 0, frame: 0 })
  })

  it('reaches the cycle behind a transition played once', () => {
    // A `once` clip in front of a cycle still hands over the way it always
    // did, and the cycle's own laps begin from the handover rather than from
    // time zero.
    const clips = [onceOf(SIX), loopOf(THREE), loopOf(SIX)]
    expect(sequenceFrameAt(clips, 500)).toEqual({ clip: 0, frame: 5 })
    expect(sequenceFrameAt(clips, 600)).toEqual({ clip: 1, frame: 0 })
    expect(sequenceFrameAt(clips, 1200)).toEqual({ clip: 2, frame: 0 })
    expect(sequenceFrameAt(clips, 1800)).toEqual({ clip: 1, frame: 0 })
  })

  it('holds the head of a cycle whose clips have no time in them at all', () => {
    // A zero-length cycle has no position to compute and must not divide by
    // its own length — the same guard `framePositionPercent` needs.
    const empty = [loopOf({ src: 'none.png', frames: 0, frameMs: 100 })]
    expect(sequenceFrameAt(empty, 5000)).toEqual({ clip: 0, frame: 0 })
  })
})

describe('sequenceCycle (#325)', () => {
  /*
   * The settled cycle's clips, named once so that both the frame arithmetic
   * above and reduced motion (see dwarfSequence's `stillFrameOf`) read the same
   * answer rather than each deriving its own.
   */
  it('is the run of loop clips a sequence settles into', () => {
    expect(sequenceCycle([loopOf(SIX)])).toEqual({ first: 0, last: 0 })
    expect(sequenceCycle([onceOf(THREE), loopOf(SIX)])).toEqual({ first: 1, last: 1 })
    expect(sequenceCycle([loopOf(THREE), loopOf(SIX), loopOf(ONE)])).toEqual({ first: 0, last: 2 })
  })

  it('stops at the first clip that is not part of it', () => {
    // Everything behind the cycle is unreachable, so it cannot extend past a
    // `once` and pick the loops up again on the other side.
    expect(sequenceCycle([loopOf(THREE), onceOf(SIX), loopOf(ONE)])).toEqual({ first: 0, last: 0 })
  })

  it('is nothing at all for a sequence that settles on a held frame', () => {
    expect(sequenceCycle([onceOf(THREE)])).toBeUndefined()
    expect(sequenceCycle([])).toBeUndefined()
  })
})

describe('sequenceDurationMs', () => {
  it('adds up the once-clips a sequence has to play before it settles', () => {
    expect(sequenceDurationMs([onceOf(THREE), loopOf(SIX)])).toBe(600)
  })

  it('reports a sequence that starts on a loop as settled straight away', () => {
    expect(sequenceDurationMs([loopOf(SIX)])).toBe(0)
  })

  it('counts none of a cycle, which is the settled state and not a wind-up (#325)', () => {
    // Time to settle, not time to repeat: a sequence that opens on a cycle is
    // already showing what it settles on from its very first frame, however
    // many clips that cycle turns over.
    expect(sequenceDurationMs([loopOf(THREE), loopOf(SIX), loopOf(THREE)])).toBe(0)
    expect(sequenceDurationMs([onceOf(SIX), loopOf(THREE), loopOf(SIX)])).toBe(600)
  })
})

describe('sequenceIsStill', () => {
  it('is true for a lone one-frame clip, which can never change', () => {
    expect(sequenceIsStill([loopOf(ONE)])).toBe(true)
    expect(sequenceIsStill([onceOf(ONE)])).toBe(true)
  })

  it('is true for nothing at all', () => {
    expect(sequenceIsStill([])).toBe(true)
  })

  it('is false as soon as there is a second frame or a second clip to reach', () => {
    expect(sequenceIsStill([loopOf(THREE)])).toBe(false)
    expect(sequenceIsStill([onceOf(ONE), loopOf(ONE)])).toBe(false)
  })
})

describe('isImpactFrame', () => {
  /*
   * Sparks off the rock used to be keyed on a pose name (`pick-2`). A sheet has
   * no pose names, so the sheet declares its own impacts and the sprite reads
   * them — which is what lets the pick loop #74 has yet to draw restore the
   * sparks as data rather than as code.
   */
  it('is true only on a frame the sheet names as a hit', () => {
    const swing: SpriteSheet = { src: 'swing.png', frames: 4, frameMs: 120, impactFrames: [2] }
    expect(isImpactFrame(swing, 2)).toBe(true)
    expect(isImpactFrame(swing, 0)).toBe(false)
    expect(isImpactFrame(swing, 3)).toBe(false)
  })

  it('is false throughout a sheet that names none, rather than guessing one', () => {
    for (let frame = 0; frame < SIX.frames; frame++) {
      expect(isImpactFrame(SIX, frame), String(frame)).toBe(false)
    }
  })
})

describe('isGlowFrame', () => {
  /*
   * A separate declaration from impactFrames, deliberately: the strike that
   * throws debris and the frames bright enough to earn a glow are two
   * different artistic calls (#74) — a swing can draw more brightness than
   * it draws hits, and marking every bright frame a hit would retrigger the
   * whole spark burst on each of them instead of showing a light.
   */
  it('is true only on a frame the sheet names as glowing', () => {
    const swing: SpriteSheet = { src: 'swing.png', frames: 9, frameMs: 100, glowFrames: [4, 5] }
    expect(isGlowFrame(swing, 4)).toBe(true)
    expect(isGlowFrame(swing, 5)).toBe(true)
    expect(isGlowFrame(swing, 6)).toBe(false)
    expect(isGlowFrame(swing, 3)).toBe(false)
  })

  it('is false throughout a sheet that names none, rather than guessing one', () => {
    for (let frame = 0; frame < SIX.frames; frame++) {
      expect(isGlowFrame(SIX, frame), String(frame)).toBe(false)
    }
  })
})

describe('loopOf and onceOf', () => {
  it('carry the sheet and say how it is played', () => {
    expect(loopOf(SIX)).toEqual({ sheet: SIX, playback: 'loop' })
    expect(onceOf(SIX)).toEqual({ sheet: SIX, playback: 'once' })
  })
})
