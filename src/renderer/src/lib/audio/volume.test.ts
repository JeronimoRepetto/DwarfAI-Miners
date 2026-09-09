import { describe, expect, it } from 'vitest'
import { DEFAULT_AUDIO_PREFERENCES } from '../../types'
import { AUDIO_BASE_VOLUME, channelVolume, crewVolume, sfxVolume, UI_SFX_KINDS } from './volume'

const OPEN = { hidden: false, collapsed: false }

/**
 * Every slider at full, which the DEFAULTS no longer are (#323 lowered music
 * to 10 % and the effects to 70 %). Named here so a test about the BASE volumes
 * is about the bases rather than about whatever the defaults happen to be.
 */
const FULL = {
  ...DEFAULT_AUDIO_PREFERENCES,
  musicVolume: 1,
  ambienceVolume: 1,
  voiceVolume: 1
}

describe('AUDIO_BASE_VOLUME', () => {
  it('carries the three base volumes the issues name, and nothing else', () => {
    // #174 sets music at 100%; #173 sets the ambience at 50% and a voice at 75%.
    expect(AUDIO_BASE_VOLUME).toEqual({ music: 1, ambience: 0.5, voice: 0.75 })
  })
})

describe('channelVolume', () => {
  it('scales each channel against its own base, never against another channel', () => {
    const settings = {
      ...DEFAULT_AUDIO_PREFERENCES,
      musicVolume: 0.5,
      ambienceVolume: 0.5,
      voiceVolume: 0.5
    }
    // One setting value, three different results: the bases differ on purpose.
    expect(channelVolume('music', settings, OPEN)).toBeCloseTo(0.5)
    expect(channelVolume('ambience', settings, OPEN)).toBeCloseTo(0.25)
    expect(channelVolume('voice', settings, OPEN)).toBeCloseTo(0.375)
  })

  it('plays every channel at its base when the sliders are at full', () => {
    expect(channelVolume('music', FULL, OPEN)).toBe(1)
    expect(channelVolume('ambience', FULL, OPEN)).toBe(0.5)
    expect(channelVolume('voice', FULL, OPEN)).toBe(0.75)
  })

  it('plays the quieter defaults the first listen asked for (#323)', () => {
    // Music 10% of its base, the effects 70% of theirs, the ambience untouched.
    expect(channelVolume('music', DEFAULT_AUDIO_PREFERENCES, OPEN)).toBeCloseTo(0.1)
    expect(channelVolume('ambience', DEFAULT_AUDIO_PREFERENCES, OPEN)).toBeCloseTo(0.5)
    expect(channelVolume('voice', DEFAULT_AUDIO_PREFERENCES, OPEN)).toBeCloseTo(0.525)
  })

  it('silences every channel while the app is hidden', () => {
    const gates = { hidden: true, collapsed: false }
    expect(channelVolume('music', FULL, gates)).toBe(0)
    expect(channelVolume('ambience', FULL, gates)).toBe(0)
    expect(channelVolume('voice', FULL, gates)).toBe(0)
  })

  it('leaves only the music audible while the shell is collapsed to its rail', () => {
    const gates = { hidden: false, collapsed: true }
    expect(channelVolume('music', FULL, gates)).toBe(1)
    expect(channelVolume('ambience', FULL, gates)).toBe(0)
    expect(channelVolume('voice', FULL, gates)).toBe(0)
  })

  it('lets hidden win over a collapsed rail, which is the stricter of the two', () => {
    const gates = { hidden: true, collapsed: true }
    expect(channelVolume('music', FULL, gates)).toBe(0)
  })

  it('reads a slider the caller got wrong as its default rather than as silence', () => {
    // A NaN volume is a bug somewhere upstream; rendering it as 0 would look
    // exactly like a deliberate mute and hide the bug.
    const settings = { ...DEFAULT_AUDIO_PREFERENCES, musicVolume: Number.NaN }
    expect(channelVolume('music', settings, OPEN)).toBeCloseTo(
      DEFAULT_AUDIO_PREFERENCES.musicVolume
    )
  })
})

/**
 * The interface sounds (#323): a fourth kind of clip, mixed on the voice
 * channel because that is what they are — a short answer to a press, scaled by
 * the one slider Settings now calls `Effects`.
 */
describe('sfxVolume', () => {
  it('mixes every kind on the voice channel, never on a channel of its own', () => {
    for (const kind of UI_SFX_KINDS) {
      expect(sfxVolume(kind, FULL, OPEN)).toBe(channelVolume('voice', FULL, OPEN))
    }
  })

  it('follows the Effects slider, and opens nothing at all when it is down', () => {
    const down = { ...FULL, voiceVolume: 0 }
    for (const kind of UI_SFX_KINDS) {
      expect(sfxVolume(kind, { ...FULL, voiceVolume: 0.5 }, OPEN)).toBeCloseTo(0.375)
      expect(sfxVolume(kind, down, OPEN)).toBe(0)
    }
  })

  it('silences every kind while the app is hidden, the panel press included', () => {
    const gates = { hidden: true, collapsed: false }
    for (const kind of UI_SFX_KINDS) expect(sfxVolume(kind, FULL, gates)).toBe(0)
  })

  it('silences a click on the collapsed rail but not the press that opens the panel', () => {
    // The five area buttons are not even drawn on the rail, so a click there is
    // as silent as a voice. The rail's own arrow is the one press a collapsed
    // shell does take, and it is the act of opening the app — so it plays.
    const gates = { hidden: false, collapsed: true }
    expect(sfxVolume('click', FULL, gates)).toBe(0)
    expect(sfxVolume('panel', FULL, gates)).toBe(0.75)
  })

  it('still lets hidden win over the collapsed rail for the panel press', () => {
    expect(sfxVolume('panel', FULL, { hidden: true, collapsed: true })).toBe(0)
  })
})

describe('crewVolume (#330)', () => {
  it('is the ambience channel, because the crew IS the mine now', () => {
    // The `working` bed is retired: what the crew does is what the mine sounds
    // like, so it rides the Ambience slider and every gate that slider does.
    expect(crewVolume(FULL, OPEN, 1)).toBe(channelVolume('ambience', FULL, OPEN))
  })

  it('divides by the square root of how many are sounding', () => {
    // Nine workers sound FULLER than one, not nine times louder — which is
    // what summing the clips would do, and it is how a busy mine turns into a
    // wall of noise while a quiet one stays too quiet to hear.
    expect(crewVolume(FULL, OPEN, 1)).toBeCloseTo(0.5)
    expect(crewVolume(FULL, OPEN, 2)).toBeCloseTo(0.5 / Math.SQRT2)
    expect(crewVolume(FULL, OPEN, 4)).toBeCloseTo(0.25)
  })

  it('never divides by less than one, whatever it is handed', () => {
    // A count of zero means "this one, and nothing else" rather than silence:
    // the caller counts the clip it is about to open.
    for (const count of [0, -1, Number.NaN]) {
      expect(crewVolume(FULL, OPEN, count), `${count}`).toBeCloseTo(0.5)
    }
  })

  it('follows the ambience slider, and opens nothing when it is down', () => {
    expect(crewVolume({ ...FULL, ambienceVolume: 0.5 }, OPEN, 1)).toBeCloseTo(0.25)
    expect(crewVolume({ ...FULL, ambienceVolume: 0 }, OPEN, 1)).toBe(0)
  })

  it('is silent while the app is hidden or the shell is its bare rail', () => {
    // Exactly the ambience's own answers: there is no interior on screen for
    // a crew to be heard in (#174).
    expect(crewVolume(FULL, { hidden: true, collapsed: false }, 1)).toBe(0)
    expect(crewVolume(FULL, { hidden: false, collapsed: true }, 1)).toBe(0)
  })
})
