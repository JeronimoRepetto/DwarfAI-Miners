import { describe, expect, it } from 'vitest'
import type { Dwarf } from '../../types'
import {
  AMBIENCE_CROSSFADE_MS,
  ambienceBedFor,
  ambienceMove,
  hasWorkingWorker,
  shouldCrossfadeLoopSeam
} from './ambience'

function dwarf(overrides: Partial<Dwarf>): Dwarf {
  return {
    id: 'd1',
    provider: 'claude',
    role: 'worker',
    name: 'Dwarf',
    status: 'waiting',
    sessionId: 's1',
    ...overrides
  }
}

/** A mine open, nobody working, nothing muted, the shell on screen. */
const OPEN = {
  mineId: 'mine-a',
  working: false,
  muted: false,
  hidden: false,
  collapsed: false
} as const

describe('AMBIENCE_CROSSFADE_MS', () => {
  it('is the two seconds #173 names, for both the loop seam and a state flip', () => {
    expect(AMBIENCE_CROSSFADE_MS).toBe(2000)
  })
})

describe('hasWorkingWorker', () => {
  it('is true for a worker that is working', () => {
    expect(hasWorkingWorker([dwarf({ role: 'worker', status: 'working' })])).toBe(true)
  })

  it('is true for a worker2 that is working, which is the other half of the crew', () => {
    expect(hasWorkingWorker([dwarf({ role: 'worker2', status: 'working' })])).toBe(true)
  })

  it('is false for a foreman that is working, because a foreman is not a worker', () => {
    // #173's own example: a mine with only a foreman hears `silence`. The
    // foreman's status is a session's status, not a pickaxe on rock.
    expect(hasWorkingWorker([dwarf({ role: 'foreman', status: 'working' })])).toBe(false)
  })

  it.each(['waiting', 'leaving'] as const)('is false for a worker that is %s', (status) => {
    expect(hasWorkingWorker([dwarf({ role: 'worker', status })])).toBe(false)
  })

  it('is false for an empty mine', () => {
    expect(hasWorkingWorker([])).toBe(false)
  })

  it('needs only one of the crew to be working', () => {
    expect(
      hasWorkingWorker([
        dwarf({ id: 'a', role: 'foreman', status: 'working' }),
        dwarf({ id: 'b', role: 'worker', status: 'waiting' }),
        dwarf({ id: 'c', role: 'worker2', status: 'working' })
      ])
    ).toBe(true)
  })
})

describe('ambienceBedFor', () => {
  it('plays the working bed while a worker is working', () => {
    expect(ambienceBedFor({ ...OPEN, working: true })).toBe('working')
  })

  it('plays the silence bed while nobody is working', () => {
    expect(ambienceBedFor(OPEN)).toBe('silence')
  })

  it('plays nothing at all with no mine interior open', () => {
    // Not the silence bed: `silence` is a recording of a quiet mine, and there
    // is no mine to be quiet.
    expect(ambienceBedFor({ ...OPEN, mineId: null, working: true })).toBeNull()
  })

  it('plays nothing while the ambience is muted, whatever the crew is doing', () => {
    expect(ambienceBedFor({ ...OPEN, working: true, muted: true })).toBeNull()
  })

  it('plays nothing while the app is hidden', () => {
    expect(ambienceBedFor({ ...OPEN, working: true, hidden: true })).toBeNull()
  })

  it('plays nothing while the shell is collapsed to its rail', () => {
    // Only the music survives the rail (#174); there is no interior on screen
    // for an ambience to belong to.
    expect(ambienceBedFor({ ...OPEN, working: true, collapsed: true })).toBeNull()
  })
})

describe('ambienceMove', () => {
  it('cuts a bed in when a mine interior opens, with nothing to fade from', () => {
    expect(ambienceMove(null, OPEN)).toEqual({ kind: 'cut', mineId: 'mine-a', bed: 'silence' })
  })

  it('crossfades over two seconds when the last worker starts working', () => {
    expect(ambienceMove({ mineId: 'mine-a', bed: 'silence' }, { ...OPEN, working: true })).toEqual({
      kind: 'crossfade',
      mineId: 'mine-a',
      bed: 'working',
      ms: AMBIENCE_CROSSFADE_MS
    })
  })

  it('crossfades back the same way when the last working worker stops', () => {
    expect(ambienceMove({ mineId: 'mine-a', bed: 'working' }, OPEN)).toEqual({
      kind: 'crossfade',
      mineId: 'mine-a',
      bed: 'silence',
      ms: AMBIENCE_CROSSFADE_MS
    })
  })

  it('cuts instantly when the person switches to another mine', () => {
    // #173 is explicit: no fade-out of the previous mine's bed. A crossfade
    // here would play one mine's crew over another mine's interior.
    expect(
      ambienceMove({ mineId: 'mine-a', bed: 'working' }, { ...OPEN, mineId: 'mine-b' })
    ).toEqual({ kind: 'cut', mineId: 'mine-b', bed: 'silence' })
  })

  it('cuts instantly on a mine switch even when the bed itself is unchanged', () => {
    expect(
      ambienceMove(
        { mineId: 'mine-a', bed: 'working' },
        { ...OPEN, mineId: 'mine-b', working: true }
      )
    ).toEqual({ kind: 'cut', mineId: 'mine-b', bed: 'working' })
  })

  it('stops when the mine interior closes', () => {
    expect(ambienceMove({ mineId: 'mine-a', bed: 'working' }, { ...OPEN, mineId: null })).toEqual({
      kind: 'stop'
    })
  })

  it('stops when the ambience is muted, and cuts back in when it is unmuted', () => {
    const standing = { mineId: 'mine-a', bed: 'working' } as const
    expect(ambienceMove(standing, { ...OPEN, working: true, muted: true })).toEqual({
      kind: 'stop'
    })
    expect(ambienceMove(null, { ...OPEN, working: true })).toEqual({
      kind: 'cut',
      mineId: 'mine-a',
      bed: 'working'
    })
  })

  it('stops while the app is hidden', () => {
    expect(
      ambienceMove({ mineId: 'mine-a', bed: 'working' }, { ...OPEN, working: true, hidden: true })
    ).toEqual({ kind: 'stop' })
  })

  it('stops while the shell is collapsed to its rail', () => {
    expect(
      ambienceMove(
        { mineId: 'mine-a', bed: 'working' },
        { ...OPEN, working: true, collapsed: true }
      )
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
