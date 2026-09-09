import { describe, expect, it } from 'vitest'
import {
  AMBIENCE_BEDS,
  AMBIENCE_CROSSFADE_MS,
  ambienceBedFor,
  ambienceMove,
  shouldCrossfadeLoopSeam
} from './ambience'

/** A mine open, nothing muted, the shell on screen. */
const OPEN = {
  mineId: 'mine-a',
  muted: false,
  hidden: false,
  collapsed: false
} as const

describe('AMBIENCE_CROSSFADE_MS', () => {
  /*
   * AMENDED for #330: it read "for both the loop seam and a state flip". There
   * is no state flip left — the `working` bed is retired, so there is one bed
   * and nothing to flip TO — and the seam is what the two seconds are for now.
   * The number itself is unchanged and is still #173's.
   */
  it('is the two seconds #173 names, which the loop seam is what is left of', () => {
    expect(AMBIENCE_CROSSFADE_MS).toBe(2000)
  })
})

/*
 * REMOVED for #330: `hasWorkingWorker` and its seven tests.
 *
 * It read the crew off the snapshot to answer WHICH bed a mine should play,
 * and the answer no longer branches: the `working` bed was one recording of "a
 * mine being worked", the same whether one worker or nine were at the rock, and
 * the crew makes the mine's noise itself now. Its coverage did not move — the
 * question it answered is not asked anywhere any more. What the crew is doing
 * is read off the FRAMES each sprite is drawing instead, in
 * `lib/sprite/crewSound.ts` and its own tests, one dwarf at a time.
 *
 * `mine-inside-working.mp3` is left on disk, unimported, for the maintainer.
 */

describe('AMBIENCE_BEDS', () => {
  it('is the one room tone, the working bed having been retired (#330)', () => {
    expect(AMBIENCE_BEDS).toEqual(['silence'])
  })
})

describe('ambienceBedFor', () => {
  /*
   * AMENDED for #330, two cases. 'plays the working bed while a worker is
   * working' is gone with the bed itself, and 'plays the silence bed while
   * nobody is working' keeps its assertion under a name that no longer implies
   * a second answer: the room tone plays whenever an interior is open and
   * unmuted, REGARDLESS of the crew.
   */
  it('plays the one room tone whenever an interior is open', () => {
    expect(ambienceBedFor(OPEN)).toBe('silence')
  })

  it('plays nothing at all with no mine interior open', () => {
    // Not the silence bed: `silence` is a recording of a quiet mine, and there
    // is no mine to be quiet.
    expect(ambienceBedFor({ ...OPEN, mineId: null })).toBeNull()
  })

  it('plays nothing while the ambience is muted, whatever the crew is doing', () => {
    expect(ambienceBedFor({ ...OPEN, muted: true })).toBeNull()
  })

  it('plays nothing while the app is hidden', () => {
    expect(ambienceBedFor({ ...OPEN, hidden: true })).toBeNull()
  })

  it('plays nothing while the shell is collapsed to its rail', () => {
    // Only the music survives the rail (#174); there is no interior on screen
    // for an ambience to belong to.
    expect(ambienceBedFor({ ...OPEN, collapsed: true })).toBeNull()
  })
})

describe('ambienceMove', () => {
  /*
   * AMENDED for #330, three cases removed and the rest restated against the
   * one bed.
   *
   * - 'crossfades over two seconds when the last worker starts working' and
   *   'crossfades back the same way when the last working worker stops' are
   *   gone with the flip they described: there is one bed, so there is nothing
   *   to fade INTO. `crossfade` is no longer a move this function can return
   *   (the loop seam runs the same two-second crossfade in the engine, and its
   *   tests are there) — the case below pins that.
   * - 'cuts instantly on a mine switch even when the bed itself is unchanged'
   *   became word for word its neighbour above once every bed was the same
   *   bed; the neighbour keeps the claim.
   */
  it('cuts a bed in when a mine interior opens, with nothing to fade from', () => {
    expect(ambienceMove(null, OPEN)).toEqual({ kind: 'cut', mineId: 'mine-a', bed: 'silence' })
  })

  it('cuts instantly when the person switches to another mine', () => {
    // #173 is explicit: no fade-out of the previous mine's bed. A crossfade
    // here would play one mine's crew over another mine's interior.
    expect(
      ambienceMove({ mineId: 'mine-a', bed: 'silence' }, { ...OPEN, mineId: 'mine-b' })
    ).toEqual({ kind: 'cut', mineId: 'mine-b', bed: 'silence' })
  })

  it('never crossfades, one bed leaving nothing to fade into (#330)', () => {
    // The state flip was the only caller of it here. What is left is a cut, a
    // stop, or nothing at all.
    const scenes = [
      OPEN,
      { ...OPEN, mineId: 'mine-b' },
      { ...OPEN, mineId: null },
      { ...OPEN, muted: true },
      { ...OPEN, hidden: true },
      { ...OPEN, collapsed: true }
    ]
    for (const standing of [null, { mineId: 'mine-a', bed: 'silence' } as const]) {
      for (const scene of scenes) {
        expect(ambienceMove(standing, scene).kind, JSON.stringify(scene)).not.toBe('crossfade')
      }
    }
  })

  it('stops when the mine interior closes', () => {
    expect(ambienceMove({ mineId: 'mine-a', bed: 'silence' }, { ...OPEN, mineId: null })).toEqual({
      kind: 'stop'
    })
  })

  it('stops when the ambience is muted, and cuts back in when it is unmuted', () => {
    const standing = { mineId: 'mine-a', bed: 'silence' } as const
    expect(ambienceMove(standing, { ...OPEN, muted: true })).toEqual({
      kind: 'stop'
    })
    expect(ambienceMove(null, OPEN)).toEqual({
      kind: 'cut',
      mineId: 'mine-a',
      bed: 'silence'
    })
  })

  it('stops while the app is hidden', () => {
    expect(ambienceMove({ mineId: 'mine-a', bed: 'silence' }, { ...OPEN, hidden: true })).toEqual({
      kind: 'stop'
    })
  })

  it('stops while the shell is collapsed to its rail', () => {
    expect(
      ambienceMove({ mineId: 'mine-a', bed: 'silence' }, { ...OPEN, collapsed: true })
    ).toEqual({ kind: 'stop' })
  })

  it('does nothing when nothing has changed', () => {
    expect(ambienceMove({ mineId: 'mine-a', bed: 'silence' }, OPEN)).toEqual({ kind: 'none' })
  })

  it('does nothing when there was nothing playing and there is nothing to play', () => {
    expect(ambienceMove(null, { ...OPEN, mineId: null })).toEqual({ kind: 'none' })
  })
})

describe('shouldCrossfadeLoopSeam', () => {
  it('starts the crossfade exactly two seconds before the bed ends', () => {
    expect(shouldCrossfadeLoopSeam(58_000, 60_000)).toBe(true)
  })

  it('leaves the bed alone until then', () => {
    expect(shouldCrossfadeLoopSeam(57_999, 60_000)).toBe(false)
    expect(shouldCrossfadeLoopSeam(0, 60_000)).toBe(false)
  })

  it('is still true past the seam, so a late tick does not skip it', () => {
    expect(shouldCrossfadeLoopSeam(59_500, 60_000)).toBe(true)
  })

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])(
    'says nothing about a bed whose length reads %j',
    (duration) => {
      // Same reading as the music timeline: an unloaded `duration` is NaN, and
      // a seam scheduled from it would crossfade a bed that had just started.
      expect(shouldCrossfadeLoopSeam(1000, duration)).toBe(false)
    }
  )

  it('refuses a bed shorter than the crossfade itself', () => {
    // A one-second bed would be crossfading from the moment it began, which is
    // a bed that never plays. Neither committed bed is anywhere near this
    // short; the guard is here so a future one cannot loop on itself forever.
    expect(shouldCrossfadeLoopSeam(0, 1000)).toBe(false)
    expect(shouldCrossfadeLoopSeam(900, 1000)).toBe(false)
  })
})
