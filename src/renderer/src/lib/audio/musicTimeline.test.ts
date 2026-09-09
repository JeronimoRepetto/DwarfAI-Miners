import { describe, expect, it } from 'vitest'
import { MUSIC_FADE_MS, MUSIC_GAP_MS, musicGainAt, musicTimeline } from './musicTimeline'

describe('the timings #174 names', () => {
  it('fades over a second and leaves a second of silence between tracks', () => {
    expect(MUSIC_FADE_MS).toBe(1000)
    expect(MUSIC_GAP_MS).toBe(1000)
  })
})

describe('musicTimeline', () => {
  it('puts the fade-in at the start, the fade-out at the end, and the gap after both', () => {
    // A three-minute track: in over its first second, out over its last, and
    // the next one starts a second after this one has actually finished.
    expect(musicTimeline(180_000)).toEqual({
      fadeInMs: 1000,
      fadeOutStartMs: 179_000,
      fadeOutMs: 1000,
      endMs: 180_000,
      nextStartMs: 181_000
    })
  })

  it('splits a track too short for both fades down the middle rather than overlapping them', () => {
    // 1.5s cannot hold a 1s fade-in AND a 1s fade-out. Halving keeps the
    // envelope continuous — it peaks once at the midpoint — where clamping
    // each fade to a second independently would have the two fight over the
    // same 500ms and produce a gain above 1 or below 0.
    expect(musicTimeline(1500)).toEqual({
      fadeInMs: 750,
      fadeOutStartMs: 750,
      fadeOutMs: 750,
      endMs: 1500,
      nextStartMs: 2500
    })
  })

  it('meets the fades exactly at a track that is precisely two fades long', () => {
    expect(musicTimeline(2000)).toEqual({
      fadeInMs: 1000,
      fadeOutStartMs: 1000,
      fadeOutMs: 1000,
      endMs: 2000,
      nextStartMs: 3000
    })
  })

  it.each([Number.NaN, 0, -5, Number.POSITIVE_INFINITY])(
    'refuses to schedule an end for a duration of %j, and waits to be told the track ended',
    (duration) => {
      // `HTMLMediaElement.duration` is NaN until the metadata has loaded, so
      // this is the ordinary first reading and not an error. Scheduling a
      // fade-out from it would cut a track that had barely started; the
      // element's own `ended` is what drives the gap until a real duration
      // arrives.
      const timeline = musicTimeline(duration)
      expect(timeline.fadeInMs).toBe(MUSIC_FADE_MS)
      expect(timeline.fadeOutStartMs).toBe(Number.POSITIVE_INFINITY)
      expect(timeline.endMs).toBe(Number.POSITIVE_INFINITY)
      expect(timeline.nextStartMs).toBe(Number.POSITIVE_INFINITY)
    }
  )
})

describe('musicGainAt', () => {
  const timeline = musicTimeline(180_000)

  it('opens at silence, so the first sample is never a click', () => {
    expect(musicGainAt(0, timeline)).toBe(0)
  })

  it('rises linearly across the fade-in', () => {
    expect(musicGainAt(250, timeline)).toBeCloseTo(0.25)
    expect(musicGainAt(500, timeline)).toBeCloseTo(0.5)
    expect(musicGainAt(1000, timeline)).toBe(1)
  })

  it('holds at full through the body of the track', () => {
    expect(musicGainAt(1001, timeline)).toBe(1)
    expect(musicGainAt(90_000, timeline)).toBe(1)
    expect(musicGainAt(179_000, timeline)).toBe(1)
  })

  it('falls linearly across the fade-out and lands on silence at the end', () => {
    expect(musicGainAt(179_500, timeline)).toBeCloseTo(0.5)
    expect(musicGainAt(179_750, timeline)).toBeCloseTo(0.25)
    expect(musicGainAt(180_000, timeline)).toBe(0)
  })

  it('is silent on either side of the track, which is where the gap lives', () => {
    expect(musicGainAt(-1, timeline)).toBe(0)
    expect(musicGainAt(180_500, timeline)).toBe(0)
    expect(musicGainAt(181_000, timeline)).toBe(0)
  })

  it('peaks exactly once on a track too short for both fades', () => {
    const short = musicTimeline(1500)
    expect(musicGainAt(0, short)).toBe(0)
    expect(musicGainAt(750, short)).toBe(1)
    expect(musicGainAt(1500, short)).toBe(0)
  })

  it('plays a track of unknown length at full, having no end to fade towards', () => {
    const unknown = musicTimeline(Number.NaN)
    expect(musicGainAt(0, unknown)).toBe(0)
    expect(musicGainAt(1000, unknown)).toBe(1)
    expect(musicGainAt(600_000, unknown)).toBe(1)
  })
})
