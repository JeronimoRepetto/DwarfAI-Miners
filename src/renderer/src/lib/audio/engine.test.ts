import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AUDIO_PREFERENCES } from '../../types'
import { AMBIENCE_CROSSFADE_MS } from './ambience'
import { createFakeAudioPlayer, type FakeAudioPlayer } from './fakeAudioPlayer'
import { createAudioEngine, type AudioEngine } from './engine'
import { MUSIC_FADE_MS, MUSIC_GAP_MS } from './musicTimeline'

const TRACKS = ['t1.ogg', 't2.ogg', 't3.ogg'] as const
const BEDS = { working: 'working.mp3', silence: 'silence.mp3' } as const
const VOICES = { foreman: 'foreman.mp3', worker: 'worker.mp3', worker2: 'worker2.mp3' } as const
const SFX = { click: 'click.mp3', panel: 'panel.mp3' } as const

/** A clock the test advances by hand, the way the rest of the suite does. */
function clock(start = 1_000): { now: number } {
  return { now: start }
}

/**
 * A generator that leaves Fisher-Yates as the identity, so a test can name
 * which track plays: every draw picks the index it is already at.
 */
function inOrderRandom(): () => number {
  return () => 0.999999
}

describe('createAudioEngine — music (#174)', () => {
  let player: FakeAudioPlayer
  let time: { now: number }
  let engine: AudioEngine

  beforeEach(() => {
    player = createFakeAudioPlayer()
    time = clock()
    engine = createAudioEngine({
      player,
      tracks: TRACKS,
      beds: BEDS,
      voices: VOICES,
      sfx: SFX,
      random: inOrderRandom(),
      now: () => time.now
    })
  })

  it('plays nothing until it is told to', () => {
    expect(player.clips).toHaveLength(0)
  })

  it('opens a track and fades it in over a second', () => {
    engine.setMusicOn(true)
    const track = player.live()[0]!
    expect(track.src).toBe('t1.ogg')
    expect(track.playing).toBe(true)
    // Opened at silence, then ramped: the first sample must never be a click.
    expect(track.volume).toBe(0)
    // The DEFAULT music slider, which #323 lowered to 10 % of the base.
    expect(track.ramp).toEqual({ to: DEFAULT_AUDIO_PREFERENCES.musicVolume, ms: MUSIC_FADE_MS })
  })

  it('fades in to the volume the settings ask for, not to full', () => {
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, musicVolume: 0.5 })
    engine.setMusicOn(true)
    expect(player.live()[0]!.ramp).toEqual({ to: 0.5, ms: MUSIC_FADE_MS })
  })

  it('fades the track out over its own last second', () => {
    engine.setMusicOn(true)
    const track = player.live()[0]!
    player.settleRamps()
    track.setDurationMs(180_000)

    track.seekMs(178_000)
    engine.tick()
    expect(track.ramp).toBeUndefined()

    track.seekMs(179_000)
    engine.tick()
    expect(track.ramp).toEqual({ to: 0, ms: MUSIC_FADE_MS })
  })

  it('leaves a second of silence after the track ends before the next one starts', () => {
    engine.setMusicOn(true)
    const first = player.live()[0]!
    first.setDurationMs(180_000)
    first.seekMs(179_000)
    engine.tick()

    // The fade-out runs over the track's own last second, so the silence
    // starts when the track ENDS, not when the fade begins.
    time.now += MUSIC_FADE_MS
    engine.tick()
    expect(player.liveOf('t2.ogg')).toHaveLength(0)

    time.now += MUSIC_GAP_MS - 1
    engine.tick()
    expect(player.liveOf('t2.ogg')).toHaveLength(0)

    time.now += 1
    engine.tick()
    expect(player.liveOf('t2.ogg')).toHaveLength(1)
    expect(first.stopped).toBe(true)
  })

  it('starts the gap from the element ending when the duration never became readable', () => {
    // `duration` is NaN until the metadata loads, and a stream may never
    // report one at all. The element's own `ended` is the fallback.
    engine.setMusicOn(true)
    const first = player.live()[0]!
    first.end()

    engine.tick()
    expect(player.liveOf('t2.ogg')).toHaveLength(0)

    time.now += MUSIC_GAP_MS
    engine.tick()
    expect(player.liveOf('t2.ogg')).toHaveLength(1)
  })

  it('works through the whole playlist and starts a new round, never going silent', () => {
    engine.setMusicOn(true)
    const played: string[] = []
    for (let index = 0; index < 7; index++) {
      const current = player.live().find((clip) => clip.src.endsWith('.ogg'))
      expect(current).toBeDefined()
      played.push((current as { src: string }).src)
      ;(current as { end: () => void }).end()
      time.now += MUSIC_GAP_MS
      engine.tick()
    }
    expect(played.slice(0, 3).sort()).toEqual([...TRACKS].sort())
    expect(played.slice(3, 6).sort()).toEqual([...TRACKS].sort())
    expect(played[6]).toBeDefined()
  })

  it('stops the music outright when the shell button turns it off', () => {
    engine.setMusicOn(true)
    const track = player.live()[0]!
    engine.setMusicOn(false)
    expect(track.stopped).toBe(true)
    expect(player.live()).toHaveLength(0)
  })

  it('starts a fresh track when the button turns it back on', () => {
    engine.setMusicOn(true)
    engine.setMusicOn(false)
    engine.setMusicOn(true)
    expect(player.live()).toHaveLength(1)
    expect(player.live()[0]!.playing).toBe(true)
  })

  it('ignores a second request to start what is already playing', () => {
    engine.setMusicOn(true)
    const first = player.live()[0]!
    engine.setMusicOn(true)
    expect(player.live()).toEqual([first])
  })

  it('pauses rather than stops while the app is hidden, and resumes where it was', () => {
    // #174: "minimise, silence; restore, music resumes". Resuming is only
    // possible if the position survived, so this must not be a stop.
    engine.setMusicOn(true)
    const track = player.live()[0]!

    engine.setGates({ hidden: true, collapsed: false })
    expect(track.playing).toBe(false)
    expect(track.stopped).toBe(false)

    engine.setGates({ hidden: false, collapsed: false })
    expect(player.live()).toEqual([track])
    expect(track.playing).toBe(true)
  })

  it('starts the first track when the window is shown, having been hidden all along', () => {
    // The window this app creates is HIDDEN, and the shell asks for the music
    // before it is ever revealed (#174: "music at startup"). Nothing is opened
    // while nobody can hear it, so being shown has to be what starts the
    // playlist — a resume of a track that was never opened is silence forever.
    engine.setGates({ hidden: true, collapsed: false })
    engine.setMusicOn(true)
    expect(player.clips).toHaveLength(0)

    engine.setGates({ hidden: false, collapsed: false })
    expect(player.live()).toHaveLength(1)
    expect(player.live()[0]!.playing).toBe(true)
  })

  it('keeps the music playing while the shell is collapsed to its rail', () => {
    engine.setMusicOn(true)
    engine.setGates({ hidden: false, collapsed: true })
    expect(player.live()[0]!.playing).toBe(true)
  })

  it('does not resume a paused track that was turned off while hidden', () => {
    engine.setMusicOn(true)
    engine.setGates({ hidden: true, collapsed: false })
    engine.setMusicOn(false)
    engine.setGates({ hidden: false, collapsed: false })
    expect(player.live()).toHaveLength(0)
  })

  it('follows the volume slider on a track already playing, without restarting it', () => {
    engine.setMusicOn(true)
    const track = player.live()[0]!
    player.settleRamps()
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, musicVolume: 0.25 })
    expect(track.volume).toBe(0.25)
    expect(track.stopped).toBe(false)
  })

  it('leaves a track mid-fade alone when a slider moves, rather than fighting its ramp', () => {
    // Writing the new volume onto a fade-in would jump the envelope to full
    // and finish the fade early; the ramp is re-aimed instead.
    engine.setMusicOn(true)
    const track = player.live()[0]!
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, musicVolume: 0.25 })
    expect(track.ramp?.to).toBe(0.25)
  })

  it('plays nothing at all when it was given no tracks', () => {
    // #174: the engine plays what it is given and stays silent when nothing is
    // provided — never a placeholder.
    const empty = createAudioEngine({
      player,
      tracks: [],
      beds: BEDS,
      voices: VOICES,
      sfx: SFX,
      random: inOrderRandom(),
      now: () => time.now
    })
    empty.setMusicOn(true)
    expect(player.clips).toHaveLength(0)
  })
})

describe('createAudioEngine — ambience (#173)', () => {
  let player: FakeAudioPlayer
  let time: { now: number }
  let engine: AudioEngine

  const OPEN = { mineId: 'mine-a', working: false }

  beforeEach(() => {
    player = createFakeAudioPlayer()
    time = clock()
    engine = createAudioEngine({
      player,
      tracks: TRACKS,
      beds: BEDS,
      voices: VOICES,
      sfx: SFX,
      random: inOrderRandom(),
      now: () => time.now
    })
  })

  it('plays the silence bed for a mine with only a foreman', () => {
    engine.setScene(OPEN)
    const bed = player.live()[0]!
    expect(bed.src).toBe('silence.mp3')
    expect(bed.playing).toBe(true)
    // Opening a mine is a cut: the bed is simply there, at volume.
    expect(bed.volume).toBe(0.5)
    expect(bed.ramp).toBeUndefined()
  })

  it('plays the working bed once a worker starts working', () => {
    engine.setScene({ ...OPEN, working: true })
    expect(player.live()[0]!.src).toBe('working.mp3')
  })

  it('crossfades over two seconds when the state flips, both beds at once', () => {
    engine.setScene(OPEN)
    const silence = player.live()[0]!
    engine.setScene({ ...OPEN, working: true })

    const working = player.liveOf('working.mp3')[0]!
    expect(working).toBeDefined()
    expect(working.playing).toBe(true)
    expect(working.volume).toBe(0)
    expect(working.ramp).toEqual({ to: 0.5, ms: AMBIENCE_CROSSFADE_MS })
    expect(silence.ramp).toEqual({ to: 0, ms: AMBIENCE_CROSSFADE_MS })
    expect(silence.stopped).toBe(false)
  })

  it('releases the faded-out bed once its crossfade has actually run', () => {
    engine.setScene(OPEN)
    const silence = player.live()[0]!
    engine.setScene({ ...OPEN, working: true })

    time.now += AMBIENCE_CROSSFADE_MS - 1
    engine.tick()
    expect(silence.stopped).toBe(false)

    time.now += 1
    engine.tick()
    expect(silence.stopped).toBe(true)
    expect(player.live().map((clip) => clip.src)).toEqual(['working.mp3'])
  })

  it('crossfades back the same way when the last working worker stops', () => {
    engine.setScene({ ...OPEN, working: true })
    const working = player.live()[0]!
    engine.setScene(OPEN)
    expect(working.ramp).toEqual({ to: 0, ms: AMBIENCE_CROSSFADE_MS })
    expect(player.liveOf('silence.mp3')[0]!.ramp).toEqual({
      to: 0.5,
      ms: AMBIENCE_CROSSFADE_MS
    })
  })

  it('cuts instantly when the person switches to another mine', () => {
    engine.setScene({ ...OPEN, working: true })
    const first = player.live()[0]!
    engine.setScene({ mineId: 'mine-b', working: false })

    // No fade-out of the previous mine's bed (#173).
    expect(first.stopped).toBe(true)
    expect(player.live().map((clip) => clip.src)).toEqual(['silence.mp3'])
    expect(player.live()[0]!.ramp).toBeUndefined()
  })

  it('drops a crossfade already in flight when the mine changes under it', () => {
    engine.setScene(OPEN)
    engine.setScene({ ...OPEN, working: true })
    expect(player.live()).toHaveLength(2)

    engine.setScene({ mineId: 'mine-b', working: true })
    expect(player.live().map((clip) => clip.src)).toEqual(['working.mp3'])
    expect(player.live()[0]!.volume).toBe(0.5)
  })

  it('stops the ambience when the mine interior closes', () => {
    engine.setScene({ ...OPEN, working: true })
    const bed = player.live()[0]!
    engine.setScene({ mineId: null, working: false })
    expect(bed.stopped).toBe(true)
    expect(player.live()).toHaveLength(0)
  })

  it('crossfades the bed into a fresh copy of itself two seconds before it ends', () => {
    engine.setScene({ ...OPEN, working: true })
    const first = player.live()[0]!
    first.setDurationMs(60_000)

    first.seekMs(57_999)
    engine.tick()
    expect(player.liveOf('working.mp3')).toHaveLength(1)

    first.seekMs(58_000)
    engine.tick()
    const copies = player.liveOf('working.mp3')
    expect(copies).toHaveLength(2)
    expect(first.ramp).toEqual({ to: 0, ms: AMBIENCE_CROSSFADE_MS })
    expect(copies[1]!.ramp).toEqual({ to: 0.5, ms: AMBIENCE_CROSSFADE_MS })
  })

  it('crossfades the seam into the OTHER bed when the state flipped at the same moment', () => {
    // One operation, not two: the seam and a state flip are the same 2s
    // crossfade, so a flip that lands on the seam must not run both.
    engine.setScene({ ...OPEN, working: true })
    const first = player.live()[0]!
    first.setDurationMs(60_000)
    first.seekMs(58_000)
    engine.setScene(OPEN)
    engine.tick()
    expect(player.liveOf('working.mp3')).toHaveLength(1)
    expect(player.liveOf('silence.mp3')).toHaveLength(1)
  })

  it('does not start a second seam while the first is still running', () => {
    engine.setScene({ ...OPEN, working: true })
    const first = player.live()[0]!
    first.setDurationMs(60_000)
    first.seekMs(58_000)
    engine.tick()
    first.seekMs(59_000)
    engine.tick()
    expect(player.liveOf('working.mp3')).toHaveLength(2)
  })

  it('gives the copy the seam faded in a seam of its own, rather than going silent (#322)', () => {
    // The bed loops for as long as the interior is open, so EVERY copy the
    // seam opens has to reach its own seam. Two plays and silence is what the
    // seam flag caused when it came to describe the incoming copy.
    engine.setScene({ ...OPEN, working: true })
    const first = player.live()[0]!
    first.setDurationMs(60_000)
    first.seekMs(58_000)
    engine.tick()

    const second = player.liveOf('working.mp3')[1]!
    second.setDurationMs(60_000)
    second.seekMs(58_000)
    engine.tick()

    const copies = player.liveOf('working.mp3')
    expect(copies).toHaveLength(3)
    expect(second.ramp).toEqual({ to: 0, ms: AMBIENCE_CROSSFADE_MS })
    expect(copies[2]!.ramp).toEqual({ to: 0.5, ms: AMBIENCE_CROSSFADE_MS })
  })

  it('keeps seaming after a state flip landed on a seam (#322)', () => {
    engine.setScene({ ...OPEN, working: true })
    const working = player.live()[0]!
    working.setDurationMs(60_000)
    working.seekMs(58_000)
    // One crossfade, into the other bed: the flip and the seam are one act.
    engine.setScene(OPEN)
    engine.tick()
    expect(player.liveOf('silence.mp3')).toHaveLength(1)

    const second = player.liveOf('silence.mp3')[0]!
    second.setDurationMs(60_000)
    second.seekMs(58_000)
    engine.tick()
    expect(player.liveOf('silence.mp3')).toHaveLength(2)

    const third = player.liveOf('silence.mp3')[1]!
    third.setDurationMs(60_000)
    third.seekMs(58_000)
    engine.tick()
    expect(player.liveOf('silence.mp3')).toHaveLength(3)
    expect(third.ramp).toEqual({ to: 0, ms: AMBIENCE_CROSSFADE_MS })
  })

  it('goes silent when the interior is muted, and comes back on a cut', () => {
    engine.setScene({ ...OPEN, working: true })
    const bed = player.live()[0]!

    engine.setAmbienceMuted(true)
    expect(bed.stopped).toBe(true)
    expect(player.live()).toHaveLength(0)

    engine.setAmbienceMuted(false)
    expect(player.live().map((clip) => clip.src)).toEqual(['working.mp3'])
  })

  it('stops the ambience while the app is hidden and brings it back when shown', () => {
    engine.setScene({ ...OPEN, working: true })
    engine.setGates({ hidden: true, collapsed: false })
    expect(player.live()).toHaveLength(0)

    engine.setGates({ hidden: false, collapsed: false })
    expect(player.live().map((clip) => clip.src)).toEqual(['working.mp3'])
  })

  it('stops the ambience while the shell is collapsed to its rail', () => {
    engine.setScene({ ...OPEN, working: true })
    engine.setGates({ hidden: false, collapsed: true })
    expect(player.live()).toHaveLength(0)
  })

  it('follows the ambience slider on a bed already playing', () => {
    engine.setScene({ ...OPEN, working: true })
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, ambienceVolume: 0.5 })
    // Base 50% of the slider's 50%.
    expect(player.live()[0]!.volume).toBeCloseTo(0.25)
  })

  it('leaves the music alone when the interior is muted', () => {
    // #173: the mute silences the ambience only — "music keeps playing".
    engine.setMusicOn(true)
    engine.setScene({ ...OPEN, working: true })
    engine.setAmbienceMuted(true)
    expect(player.liveOf('t1.ogg')).toHaveLength(1)
    expect(player.liveOf('t1.ogg')[0]!.playing).toBe(true)
  })
})

describe('createAudioEngine — voices (#173)', () => {
  let player: FakeAudioPlayer
  let time: { now: number }
  let engine: AudioEngine

  beforeEach(() => {
    player = createFakeAudioPlayer()
    time = clock()
    engine = createAudioEngine({
      player,
      tracks: TRACKS,
      beds: BEDS,
      voices: VOICES,
      sfx: SFX,
      random: inOrderRandom(),
      now: () => time.now
    })
  })

  it.each(['foreman', 'worker', 'worker2'] as const)('plays %s its own voice, once', (role) => {
    engine.playVoice(role)
    const clips = player.live()
    expect(clips).toHaveLength(1)
    expect(clips[0]!.src).toBe(VOICES[role])
    expect(clips[0]!.playing).toBe(true)
    // A bark is a cut, not a fade: it is over before a fade would finish.
    // 75 % base against the default Effects slider, which #323 put at 70 %.
    expect(clips[0]!.volume).toBeCloseTo(0.525)
    expect(clips[0]!.ramp).toBeUndefined()
  })

  it('plays at the voice slider, scaled against the voice base', () => {
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, voiceVolume: 0.5 })
    engine.playVoice('worker')
    expect(player.live()[0]!.volume).toBeCloseTo(0.375)
  })

  it('replaces a voice still speaking rather than layering two', () => {
    engine.playVoice('worker')
    const first = player.live()[0]!
    engine.playVoice('foreman')
    expect(first.stopped).toBe(true)
    expect(player.live().map((clip) => clip.src)).toEqual(['foreman.mp3'])
  })

  it('releases the clip when the bark finishes', () => {
    engine.playVoice('worker')
    const voice = player.clips[0]!
    voice.end()
    expect(voice.stopped).toBe(true)
  })

  it('says nothing while the app is hidden', () => {
    engine.setGates({ hidden: true, collapsed: false })
    engine.playVoice('worker')
    expect(player.clips).toHaveLength(0)
  })

  it('says nothing while the shell is collapsed to its rail', () => {
    engine.setGates({ hidden: false, collapsed: true })
    engine.playVoice('worker')
    expect(player.clips).toHaveLength(0)
  })

  it('says nothing when the voice slider is all the way down', () => {
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, voiceVolume: 0 })
    engine.playVoice('worker')
    expect(player.clips).toHaveLength(0)
  })

  it('cuts a voice mid-bark when the app is hidden', () => {
    engine.playVoice('worker')
    const voice = player.live()[0]!
    engine.setGates({ hidden: true, collapsed: false })
    expect(voice.stopped).toBe(true)
  })
})

/**
 * A fourth kind of clip, on the voice channel (#323): the navigation buttons
 * click, and the secondary panel makes a sound when it opens and closes.
 */
describe('createAudioEngine — interface sounds (#323)', () => {
  let player: FakeAudioPlayer
  let time: { now: number }
  let engine: AudioEngine

  beforeEach(() => {
    player = createFakeAudioPlayer()
    time = clock()
    engine = createAudioEngine({
      player,
      tracks: TRACKS,
      beds: BEDS,
      voices: VOICES,
      sfx: SFX,
      random: inOrderRandom(),
      now: () => time.now
    })
  })

  it.each(['click', 'panel'] as const)('plays %s its own recording, once', (kind) => {
    engine.playSfx(kind)
    const clips = player.live()
    expect(clips).toHaveLength(1)
    expect(clips[0]!.src).toBe(SFX[kind])
    expect(clips[0]!.playing).toBe(true)
    // A cut, like a bark: it is over before a fade would finish.
    expect(clips[0]!.volume).toBeCloseTo(0.525)
    expect(clips[0]!.ramp).toBeUndefined()
  })

  it('plays at the Effects slider, scaled against the voice base', () => {
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, voiceVolume: 0.5 })
    engine.playSfx('click')
    expect(player.live()[0]!.volume).toBeCloseTo(0.375)
  })

  it('replaces an interface sound still playing rather than layering two', () => {
    engine.playSfx('click')
    const first = player.live()[0]!
    engine.playSfx('click')
    expect(first.stopped).toBe(true)
    expect(player.live()).toHaveLength(1)
  })

  it('lets a voice and an interface sound overlap, because they are different acts', () => {
    // One press can be both — a dwarf clicked inside a mine speaks while the
    // interface answers the press — and cutting either would be wrong.
    engine.playVoice('worker')
    engine.playSfx('click')
    expect(player.live().map((clip) => clip.src)).toEqual(['worker.mp3', 'click.mp3'])
  })

  it('releases the clip when the sound finishes', () => {
    engine.playSfx('panel')
    const clip = player.clips[0]!
    clip.end()
    expect(clip.stopped).toBe(true)
  })

  it('makes no sound while the app is hidden', () => {
    engine.setGates({ hidden: true, collapsed: false })
    engine.playSfx('click')
    engine.playSfx('panel')
    expect(player.clips).toHaveLength(0)
  })

  it('cuts an interface sound mid-play when the app is hidden', () => {
    engine.playSfx('panel')
    const clip = player.live()[0]!
    engine.setGates({ hidden: true, collapsed: false })
    expect(clip.stopped).toBe(true)
  })

  it('says nothing when the Effects slider is all the way down', () => {
    // Nothing to hear, so nothing to decode — the rule playVoice already holds.
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, voiceVolume: 0 })
    engine.playSfx('click')
    engine.playSfx('panel')
    expect(player.clips).toHaveLength(0)
  })

  it('swallows a click on the collapsed rail but still plays the panel opening', () => {
    // The five area buttons are not drawn on the rail, so a click there has
    // nothing to answer. The arrow that opens the panel is the exception, and
    // it is the whole reason the exception exists.
    engine.setGates({ hidden: false, collapsed: true })
    engine.playSfx('click')
    expect(player.clips).toHaveLength(0)

    engine.playSfx('panel')
    expect(player.live().map((clip) => clip.src)).toEqual(['panel.mp3'])
  })

  it('releases an interface sound on dispose, and makes none afterwards', () => {
    engine.playSfx('panel')
    const clip = player.live()[0]!
    engine.dispose()
    expect(clip.stopped).toBe(true)

    engine.playSfx('click')
    expect(player.live()).toHaveLength(0)
  })
})

describe('createAudioEngine — dispose', () => {
  it('releases every sound it opened', () => {
    const player = createFakeAudioPlayer()
    const time = clock()
    const engine = createAudioEngine({
      player,
      tracks: TRACKS,
      beds: BEDS,
      voices: VOICES,
      sfx: SFX,
      random: inOrderRandom(),
      now: () => time.now
    })
    engine.setMusicOn(true)
    engine.setScene({ mineId: 'mine-a', working: true })
    engine.playVoice('foreman')
    expect(player.live()).toHaveLength(3)

    engine.dispose()
    expect(player.live()).toHaveLength(0)
  })

  it('plays nothing after it has been disposed', () => {
    const player = createFakeAudioPlayer()
    const time = clock()
    const engine = createAudioEngine({
      player,
      tracks: TRACKS,
      beds: BEDS,
      voices: VOICES,
      sfx: SFX,
      random: inOrderRandom(),
      now: () => time.now
    })
    engine.dispose()
    engine.setMusicOn(true)
    engine.setScene({ mineId: 'mine-a', working: true })
    engine.playVoice('foreman')
    engine.tick()
    expect(player.clips).toHaveLength(0)
  })
})
