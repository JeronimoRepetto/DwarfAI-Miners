import { describe, expect, it } from 'vitest'
import { DEFAULT_AUDIO_PREFERENCES } from '../../types'
import { AUDIO_BASE_VOLUME, channelVolume } from './volume'

const OPEN = { hidden: false, collapsed: false }

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
    expect(channelVolume('music', DEFAULT_AUDIO_PREFERENCES, OPEN)).toBe(1)
    expect(channelVolume('ambience', DEFAULT_AUDIO_PREFERENCES, OPEN)).toBe(0.5)
    expect(channelVolume('voice', DEFAULT_AUDIO_PREFERENCES, OPEN)).toBe(0.75)
  })

  it('silences every channel while the app is hidden', () => {
    const gates = { hidden: true, collapsed: false }
    expect(channelVolume('music', DEFAULT_AUDIO_PREFERENCES, gates)).toBe(0)
    expect(channelVolume('ambience', DEFAULT_AUDIO_PREFERENCES, gates)).toBe(0)
    expect(channelVolume('voice', DEFAULT_AUDIO_PREFERENCES, gates)).toBe(0)
  })

  it('leaves only the music audible while the shell is collapsed to its rail', () => {
    const gates = { hidden: false, collapsed: true }
    expect(channelVolume('music', DEFAULT_AUDIO_PREFERENCES, gates)).toBe(1)
    expect(channelVolume('ambience', DEFAULT_AUDIO_PREFERENCES, gates)).toBe(0)
    expect(channelVolume('voice', DEFAULT_AUDIO_PREFERENCES, gates)).toBe(0)
  })

  it('lets hidden win over a collapsed rail, which is the stricter of the two', () => {
    const gates = { hidden: true, collapsed: true }
    expect(channelVolume('music', DEFAULT_AUDIO_PREFERENCES, gates)).toBe(0)
  })

  it('reads a slider the caller got wrong as its default rather than as silence', () => {
    // A NaN volume is a bug somewhere upstream; rendering it as 0 would look
    // exactly like a deliberate mute and hide the bug.
    const settings = { ...DEFAULT_AUDIO_PREFERENCES, musicVolume: Number.NaN }
    expect(channelVolume('music', settings, OPEN)).toBe(1)
  })
})
