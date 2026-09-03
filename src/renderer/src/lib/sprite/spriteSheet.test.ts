import { describe, expect, it } from 'vitest'
import type { SpriteSheet } from './spriteSheet'
import {
  SPRITE_FRAME_SIZE,
  backgroundSizePercent,
  framePositionPercent,
  isImpactFrame,
  loopOf,
  onceOf,
  sequenceDurationMs,
  sequenceFrameAt
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

  it('never runs a looping clip out, so nothing behind one is ever reached', () => {
    const clips = [loopOf(THREE), loopOf(SIX)]
    expect(sequenceFrameAt(clips, 60_000)).toEqual({ clip: 0, frame: 0 })
  })

  it('treats time before the start as the start', () => {
    expect(sequenceFrameAt([loopOf(THREE)], -500)).toEqual({ clip: 0, frame: 0 })
  })

  it('answers an empty sequence rather than throwing', () => {
    expect(sequenceFrameAt([], 1000)).toEqual({ clip: 0, frame: 0 })
  })
})

describe('sequenceDurationMs', () => {
  it('adds up the once-clips a sequence has to play before it settles', () => {
    expect(sequenceDurationMs([onceOf(THREE), loopOf(SIX)])).toBe(600)
  })

  it('reports a sequence that starts on a loop as settled straight away', () => {
    expect(sequenceDurationMs([loopOf(SIX)])).toBe(0)
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

describe('loopOf and onceOf', () => {
  it('carry the sheet and say how it is played', () => {
    expect(loopOf(SIX)).toEqual({ sheet: SIX, playback: 'loop' })
    expect(onceOf(SIX)).toEqual({ sheet: SIX, playback: 'once' })
  })
})
