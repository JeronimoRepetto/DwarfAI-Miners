import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AUDIO_PREFERENCES } from '../../types'
import { AMBIENCE_CROSSFADE_MS } from './ambience'
import { CREW_POLYPHONY, CREW_RELEASE_MS, type CrewSoundEvent } from './crew'
import { createFakeAudioPlayer, type FakeAudioClip, type FakeAudioPlayer } from './fakeAudioPlayer'
import { createAudioEngine, type AudioEngine } from './engine'
import { MUSIC_FADE_MS, MUSIC_GAP_MS } from './musicTimeline'

const TRACKS = ['t1.ogg', 't2.ogg', 't3.ogg'] as const
// AMENDED for #330: the `working` bed is retired, so there is one room tone.
const BEDS = { silence: 'silence.mp3' } as const
const VOICES = { foreman: 'foreman.mp3', worker: 'worker.mp3', worker2: 'worker2.mp3' } as const
const SFX = { click: 'click.mp3', panel: 'panel.mp3' } as const
/**
 * The crew's own recordings (#330), one list per cue exactly as the real
 * inventory is: two footstep variants, and one recording for each rank's own
 * cue. The foreman declares neither a strike nor a shift.
 */
const CREW = {
  worker: { strike: ['pick.mp3'], walk: ['steps.mp3', 'steps2.mp3'] },
  worker2: { shift: ['hands.mp3'], walk: ['steps.mp3', 'steps2.mp3'] },
  foreman: { walk: ['steps.mp3', 'steps2.mp3'] }
} as const

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
      crew: CREW,
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
      crew: CREW,
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

  const OPEN = { mineId: 'mine-a' }

  beforeEach(() => {
    player = createFakeAudioPlayer()
    time = clock()
    engine = createAudioEngine({
      player,
      tracks: TRACKS,
      beds: BEDS,
      voices: VOICES,
      sfx: SFX,
      crew: CREW,
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

  /*
   * REMOVED for #330, three cases, all of them the two-bed state flip:
   *
   * - 'plays the working bed once a worker starts working'
   * - 'crossfades over two seconds when the state flips, both beds at once'
   * - 'crossfades back the same way when the last working worker stops'
   *
   * There is one bed, so there is nothing to flip to and nothing to cross into
   * — the crew's own clips are what say anything about the crew now, and their
   * cases are in the crew block below. What the removed three actually
   * protected is not lost: that a bed opens at volume on a cut, that the
   * two-second crossfade runs both clips at once, and that the outgoing one is
   * released when it has finished, are all still pinned — by the case above
   * and by the LOOP SEAM cases below, which is the crossfade that survives
   * (#322). The one immediately below was the flip's release case and is
   * amended to be driven from the seam instead.
   */
  it('releases the faded-out bed once its crossfade has actually run', () => {
    engine.setScene(OPEN)
    const first = player.live()[0]!
    first.setDurationMs(60_000)
    first.seekMs(58_000)
    engine.tick()
    expect(first.ramp).toEqual({ to: 0, ms: AMBIENCE_CROSSFADE_MS })

    time.now += AMBIENCE_CROSSFADE_MS - 1
    engine.tick()
    expect(first.stopped).toBe(false)

    time.now += 1
    engine.tick()
    expect(first.stopped).toBe(true)
    expect(player.live().map((clip) => clip.src)).toEqual(['silence.mp3'])
  })

  it('cuts instantly when the person switches to another mine', () => {
    engine.setScene(OPEN)
    const first = player.live()[0]!
    engine.setScene({ mineId: 'mine-b' })

    // No fade-out of the previous mine's bed (#173).
    expect(first.stopped).toBe(true)
    expect(player.live().map((clip) => clip.src)).toEqual(['silence.mp3'])
    expect(player.live()[0]!.ramp).toBeUndefined()
  })

  it('drops a crossfade already in flight when the mine changes under it', () => {
    // AMENDED for #330: the crossfade in flight was a state flip's; it is the
    // LOOP SEAM's now, which is the only two-second crossfade left. The claim
    // is unchanged — a mine switch discards the outgoing bed rather than
    // letting it finish fading over another mine's interior.
    engine.setScene(OPEN)
    const first = player.live()[0]!
    first.setDurationMs(60_000)
    first.seekMs(58_000)
    engine.tick()
    expect(player.live()).toHaveLength(2)

    engine.setScene({ mineId: 'mine-b' })
    expect(player.live().map((clip) => clip.src)).toEqual(['silence.mp3'])
    expect(player.live()[0]!.volume).toBe(0.5)
  })

  it('stops the ambience when the mine interior closes', () => {
    engine.setScene(OPEN)
    const bed = player.live()[0]!
    engine.setScene({ mineId: null })
    expect(bed.stopped).toBe(true)
    expect(player.live()).toHaveLength(0)
  })

  it('crossfades the bed into a fresh copy of itself two seconds before it ends', () => {
    engine.setScene(OPEN)
    const first = player.live()[0]!
    first.setDurationMs(60_000)

    first.seekMs(57_999)
    engine.tick()
    expect(player.liveOf('silence.mp3')).toHaveLength(1)

    first.seekMs(58_000)
    engine.tick()
    const copies = player.liveOf('silence.mp3')
    expect(copies).toHaveLength(2)
    expect(first.ramp).toEqual({ to: 0, ms: AMBIENCE_CROSSFADE_MS })
    expect(copies[1]!.ramp).toEqual({ to: 0.5, ms: AMBIENCE_CROSSFADE_MS })
  })

  /*
   * REMOVED for #330: 'crossfades the seam into the OTHER bed when the state
   * flipped at the same moment'. It pinned that a flip landing exactly on the
   * seam ran ONE crossfade rather than two — a case that cannot arise with one
   * bed, because there is no other bed to be flipped into. The seam running
   * once is still pinned by the case immediately below.
   */
  it('does not start a second seam while the first is still running', () => {
    engine.setScene(OPEN)
    const first = player.live()[0]!
    first.setDurationMs(60_000)
    first.seekMs(58_000)
    engine.tick()
    first.seekMs(59_000)
    engine.tick()
    expect(player.liveOf('silence.mp3')).toHaveLength(2)
  })

  it('gives the copy the seam faded in a seam of its own, rather than going silent (#322)', () => {
    // The bed loops for as long as the interior is open, so EVERY copy the
    // seam opens has to reach its own seam. Two plays and silence is what the
    // seam flag caused when it came to describe the incoming copy.
    engine.setScene(OPEN)
    const first = player.live()[0]!
    first.setDurationMs(60_000)
    first.seekMs(58_000)
    engine.tick()

    const second = player.liveOf('silence.mp3')[1]!
    second.setDurationMs(60_000)
    second.seekMs(58_000)
    engine.tick()

    const copies = player.liveOf('silence.mp3')
    expect(copies).toHaveLength(3)
    expect(second.ramp).toEqual({ to: 0, ms: AMBIENCE_CROSSFADE_MS })
    expect(copies[2]!.ramp).toEqual({ to: 0.5, ms: AMBIENCE_CROSSFADE_MS })
  })

  /*
   * REMOVED for #330: 'keeps seaming after a state flip landed on a seam
   * (#322)'. It followed the bed a flip had faded in through two more seams of
   * its own, and the flip is gone. #322's actual guarantee — every copy the
   * seam opens reaches its OWN seam, rather than two plays and silence — is
   * pinned by the case above, which walks the same three copies without a
   * flip to start them.
   */

  it('goes silent when the interior is muted, and comes back on a cut', () => {
    engine.setScene(OPEN)
    const bed = player.live()[0]!

    engine.setAmbienceMuted(true)
    expect(bed.stopped).toBe(true)
    expect(player.live()).toHaveLength(0)

    engine.setAmbienceMuted(false)
    expect(player.live().map((clip) => clip.src)).toEqual(['silence.mp3'])
  })

  it('stops the ambience while the app is hidden and brings it back when shown', () => {
    engine.setScene(OPEN)
    engine.setGates({ hidden: true, collapsed: false })
    expect(player.live()).toHaveLength(0)

    engine.setGates({ hidden: false, collapsed: false })
    expect(player.live().map((clip) => clip.src)).toEqual(['silence.mp3'])
  })

  it('stops the ambience while the shell is collapsed to its rail', () => {
    engine.setScene(OPEN)
    engine.setGates({ hidden: false, collapsed: true })
    expect(player.live()).toHaveLength(0)
  })

  it('follows the ambience slider on a bed already playing', () => {
    engine.setScene(OPEN)
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, ambienceVolume: 0.5 })
    // Base 50% of the slider's 50%.
    expect(player.live()[0]!.volume).toBeCloseTo(0.25)
  })

  it('leaves the music alone when the interior is muted', () => {
    // #173: the mute silences the ambience only — "music keeps playing".
    engine.setMusicOn(true)
    engine.setScene(OPEN)
    engine.setAmbienceMuted(true)
    expect(player.liveOf('t1.ogg')).toHaveLength(1)
    expect(player.liveOf('t1.ogg')[0]!.playing).toBe(true)
  })
})

/**
 * The crew's own sounds (#330), which are what the retired `working` bed used
 * to stand in for: a strike per pick that lands, one grind per worker2 shift,
 * footsteps for as long as anybody is crossing the floor.
 *
 * They ride the AMBIENCE channel — the crew is what the mine sounds like — so
 * every answer the bed gives about the slider, the interior mute, a hidden
 * window and a collapsed rail is theirs too, and they stop where the bed does.
 */
describe('createAudioEngine — the crew (#330)', () => {
  let player: FakeAudioPlayer
  let time: { now: number }
  let engine: AudioEngine

  const OPEN = { mineId: 'mine-a' }

  /** A cue as MineScene forwards one: the sprite's signal plus who made it. */
  function cue(over: Partial<CrewSoundEvent> = {}): CrewSoundEvent {
    return { mineId: 'mine-a', dwarfId: 'd1', role: 'worker', cue: 'strike', ...over }
  }

  /** The clips that are not the room tone, which is what "the crew" means here. */
  function crewClips(): readonly FakeAudioClip[] {
    return player.live().filter((clip) => clip.src !== BEDS.silence)
  }

  beforeEach(() => {
    player = createFakeAudioPlayer()
    time = clock()
    engine = createAudioEngine({
      player,
      tracks: TRACKS,
      beds: BEDS,
      voices: VOICES,
      sfx: SFX,
      crew: CREW,
      random: inOrderRandom(),
      now: () => time.now
    })
    engine.setScene(OPEN)
  })

  it("opens the rank's own recording for the cue it declared", () => {
    engine.playCrew(cue())
    expect(crewClips().map((clip) => clip.src)).toEqual(['pick.mp3'])
    expect(crewClips()[0]!.playing).toBe(true)
  })

  it('plays a grind for the worker2 and a strike for the worker, off the same call', () => {
    // Nothing here branches on the rank: the cue and the rank pick the file
    // out of the inventory, and the inventory is what says they differ.
    engine.playCrew(cue({ role: 'worker2', dwarfId: 'd2', cue: 'shift' }))
    expect(crewClips().map((clip) => clip.src)).toEqual(['hands.mp3'])
  })

  it('opens nothing for a cue the rank has no recording for', () => {
    // The foreman has no strike; asking for one must not open the worker's.
    engine.playCrew(cue({ role: 'foreman', dwarfId: 'd3', cue: 'strike' }))
    expect(crewClips()).toHaveLength(0)
  })

  it('opens at the ambience volume when it is the only crew clip sounding', () => {
    engine.playCrew(cue())
    // Base 50 % against the default ambience slider (100 %), alone: 1/sqrt(1).
    expect(crewClips()[0]!.volume).toBeCloseTo(0.5)
    // A cut, not a fade: a strike is over before a fade would finish.
    expect(crewClips()[0]!.ramp).toBeUndefined()
  })

  it('divides by the square root of how many are sounding at once', () => {
    // Nine workers sound fuller than one, not nine times louder.
    engine.playCrew(cue({ dwarfId: 'd1' }))
    engine.playCrew(cue({ dwarfId: 'd2' }))
    engine.playCrew(cue({ dwarfId: 'd3' }))
    const volumes = crewClips().map((clip) => clip.volume)
    expect(volumes[0]).toBeCloseTo(0.5)
    expect(volumes[1]).toBeCloseTo(0.5 / Math.SQRT2)
    expect(volumes[2]).toBeCloseTo(0.5 / Math.sqrt(3))
  })

  it('drops a fourth cue rather than queueing it', () => {
    // A missing strike in a busy mine is inaudible; a rattle is not, and a
    // queue would pay one back after the pick that threw it had lifted again.
    for (const dwarfId of ['d1', 'd2', 'd3', 'd4']) engine.playCrew(cue({ dwarfId }))
    expect(crewClips()).toHaveLength(CREW_POLYPHONY)
  })

  it('lets a released clip make room again', () => {
    for (const dwarfId of ['d1', 'd2', 'd3']) engine.playCrew(cue({ dwarfId, cue: 'walk' }))
    engine.playCrew(cue({ dwarfId: 'd1', cue: 'walk', ending: true }))
    time.now += CREW_RELEASE_MS
    engine.tick()
    engine.playCrew(cue({ dwarfId: 'd4' }))
    expect(crewClips()).toHaveLength(CREW_POLYPHONY)
    expect(crewClips().some((clip) => clip.src === 'pick.mp3')).toBe(true)
  })

  it('releases the clip when a strike finishes on its own', () => {
    engine.playCrew(cue())
    const strike = player.clips.at(-1)!
    strike.end()
    expect(strike.stopped).toBe(true)
    // And the slot it held is free again, or nine workers would fall silent
    // after three strikes for the rest of the run.
    for (const dwarfId of ['d2', 'd3', 'd4']) engine.playCrew(cue({ dwarfId }))
    expect(crewClips()).toHaveLength(CREW_POLYPHONY)
  })

  it('opens nothing for a cue from a mine that is not the one on screen', () => {
    // What you hear is what is drawn: a sprite in a scene the viewer has left
    // is still ticking somewhere, and it must not be audible.
    engine.playCrew(cue({ mineId: 'mine-b' }))
    expect(crewClips()).toHaveLength(0)
  })

  it('opens nothing while the interior is muted, hidden, or a bare rail', () => {
    for (const shut of ['muted', 'hidden', 'collapsed'] as const) {
      if (shut === 'muted') engine.setAmbienceMuted(true)
      else engine.setGates({ hidden: shut === 'hidden', collapsed: shut === 'collapsed' })
      engine.playCrew(cue())
      expect(crewClips(), shut).toHaveLength(0)
      if (shut === 'muted') engine.setAmbienceMuted(false)
      else engine.setGates({ hidden: false, collapsed: false })
    }
  })

  it('opens nothing with no interior open at all', () => {
    engine.setScene({ mineId: null })
    engine.playCrew(cue())
    expect(crewClips()).toHaveLength(0)
  })

  it('opens nothing when the ambience slider is all the way down', () => {
    // Nothing to hear, so nothing to decode — playVoice's own rule.
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, ambienceVolume: 0 })
    engine.playCrew(cue())
    expect(crewClips()).toHaveLength(0)
  })

  it('plays the footsteps quietly, at the gain the cue carries', () => {
    engine.playCrew(cue({ cue: 'walk', gain: 0.05 }))
    expect(crewClips()[0]!.volume).toBeCloseTo(0.5 * 0.05)
  })

  it('gives a dwarf the same footsteps every time it walks', () => {
    // It walks in on one pair of boots and it leaves in the same pair.
    const walked: string[] = []
    for (let pass = 0; pass < 3; pass++) {
      engine.playCrew(cue({ cue: 'walk', gain: 0.05 }))
      walked.push(crewClips()[0]!.src)
      engine.playCrew(cue({ cue: 'walk', ending: true }))
      time.now += CREW_RELEASE_MS
      engine.tick()
    }
    expect(new Set(walked).size).toBe(1)
    expect(CREW.worker.walk).toContain(walked[0])
  })

  it('gives two different dwarfs the two recordings between them', () => {
    // Nine copies of one gait is a crew marching in step; the pair exists so
    // that does not happen (see crewVariantIndex for why it is a hash).
    const ids = Array.from({ length: 9 }, (_, index) => `dwarf-${index}`)
    const heard = new Set(
      ids.map((dwarfId) => {
        engine.playCrew(cue({ dwarfId, cue: 'walk', gain: 0.05 }))
        const clip = crewClips().at(-1)
        engine.playCrew(cue({ dwarfId, cue: 'walk', ending: true }))
        time.now += CREW_RELEASE_MS
        engine.tick()
        return clip?.src
      })
    )
    expect(heard).toEqual(new Set(CREW.worker.walk))
  })

  it('releases a grind over 300ms when its worker2 leaves the cycle', () => {
    engine.playCrew(cue({ role: 'worker2', dwarfId: 'd2', cue: 'shift' }))
    const grind = crewClips()[0]!
    engine.playCrew(cue({ role: 'worker2', dwarfId: 'd2', cue: 'shift', ending: true }))
    // A fade rather than a cut: the recording is a continuous motion, and
    // stopping one dead leaves a click where the arms stopped.
    expect(grind.ramp).toEqual({ to: 0, ms: CREW_RELEASE_MS })
    expect(grind.stopped).toBe(false)

    time.now += CREW_RELEASE_MS - 1
    engine.tick()
    expect(grind.stopped).toBe(false)

    time.now += 1
    engine.tick()
    expect(grind.stopped).toBe(true)
  })

  it('releases only the clip of the dwarf that left, and only that cue', () => {
    engine.playCrew(cue({ role: 'worker2', dwarfId: 'd2', cue: 'shift' }))
    engine.playCrew(cue({ dwarfId: 'd1', cue: 'walk', gain: 0.05 }))
    const grind = crewClips()[0]!
    const steps = crewClips()[1]!

    engine.playCrew(cue({ dwarfId: 'd1', cue: 'walk', ending: true }))
    expect(steps.ramp).toEqual({ to: 0, ms: CREW_RELEASE_MS })
    expect(grind.ramp).toBeUndefined()
  })

  it('ignores an ending for a dwarf with nothing of that cue sounding', () => {
    engine.playCrew(cue({ dwarfId: 'd9', cue: 'walk', ending: true }))
    engine.playCrew(cue({ role: 'worker2', dwarfId: 'd9', cue: 'shift', ending: true }))
    expect(crewClips()).toHaveLength(0)
  })

  it('releases an ending even for a mine that is no longer on screen', () => {
    // The stop is the one direction the mine must NOT gate: a sprite reporting
    // that it has stopped walking is exactly what a scene being left looks
    // like, and refusing it would leave the footsteps running.
    engine.playCrew(cue({ dwarfId: 'd1', cue: 'walk', gain: 0.05 }))
    const steps = crewClips()[0]!
    engine.playCrew(cue({ mineId: 'mine-b', dwarfId: 'd1', cue: 'walk', ending: true }))
    expect(steps.ramp).toEqual({ to: 0, ms: CREW_RELEASE_MS })
  })

  it("replaces a dwarf's own grind with the next one, released rather than cut", () => {
    // A re-render that restarts the sequence is a new shift (#330), and one
    // worker2 grinding twice at once is one worker2 too many.
    engine.playCrew(cue({ role: 'worker2', dwarfId: 'd2', cue: 'shift' }))
    const first = crewClips()[0]!
    engine.playCrew(cue({ role: 'worker2', dwarfId: 'd2', cue: 'shift' }))
    // Released, so both are audible for the length of the release — the old
    // one falling, the new one at volume. That is the point: a cut here would
    // click, and the two are the same recording overlapping by 300ms.
    expect(first.ramp).toEqual({ to: 0, ms: CREW_RELEASE_MS })
    expect(first.stopped).toBe(false)
    expect(crewClips().filter((clip) => clip.src === 'hands.mp3')).toHaveLength(2)

    time.now += CREW_RELEASE_MS
    engine.tick()
    expect(first.stopped).toBe(true)
    expect(crewClips().filter((clip) => clip.src === 'hands.mp3')).toHaveLength(1)
  })

  it('stops every crew clip on a mine cut', () => {
    engine.playCrew(cue({ dwarfId: 'd1' }))
    engine.playCrew(cue({ role: 'worker2', dwarfId: 'd2', cue: 'shift' }))
    const sounding = crewClips()
    expect(sounding).toHaveLength(2)

    engine.setScene({ mineId: 'mine-b' })
    for (const clip of sounding) expect(clip.stopped).toBe(true)
    expect(crewClips()).toHaveLength(0)
  })

  it('stops every crew clip on a mute, and on hidden, and on the rail', () => {
    for (const shut of ['muted', 'hidden', 'collapsed'] as const) {
      engine.setScene(OPEN)
      engine.playCrew(cue({ dwarfId: 'd1', cue: 'walk', gain: 0.05 }))
      const steps = crewClips()[0]!
      if (shut === 'muted') engine.setAmbienceMuted(true)
      else engine.setGates({ hidden: shut === 'hidden', collapsed: shut === 'collapsed' })
      expect(steps.stopped, shut).toBe(true)
      if (shut === 'muted') engine.setAmbienceMuted(false)
      else engine.setGates({ hidden: false, collapsed: false })
    }
  })

  it('drops the clips a release had not finished, on a cut', () => {
    // Same rule the outgoing bed follows: it belongs to a mine that is no
    // longer on screen, so letting it finish fading would be the panel still
    // saying something about it.
    engine.playCrew(cue({ dwarfId: 'd1', cue: 'walk', gain: 0.05 }))
    const steps = crewClips()[0]!
    engine.playCrew(cue({ dwarfId: 'd1', cue: 'walk', ending: true }))
    engine.setScene({ mineId: null })
    expect(steps.stopped).toBe(true)
  })

  it('follows the ambience slider on a grind already sounding', () => {
    // A grind runs for eight and a half seconds, which is long enough for
    // somebody to reach for the slider while it plays.
    engine.playCrew(cue({ role: 'worker2', dwarfId: 'd2', cue: 'shift' }))
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, ambienceVolume: 0.5 })
    expect(crewClips()[0]!.volume).toBeCloseTo(0.25)
  })

  it("keeps a clip's own share of the mix when the slider moves", () => {
    // Two sounding, so each is at 1/sqrt(2) of the channel — and it stays its
    // share afterwards rather than jumping to the whole channel.
    engine.playCrew(cue({ dwarfId: 'd1' }))
    engine.playCrew(cue({ dwarfId: 'd2' }))
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, ambienceVolume: 0.5 })
    expect(crewClips()[1]!.volume).toBeCloseTo(0.25 / Math.SQRT2)
  })

  it('keeps the footsteps quiet when the slider moves too', () => {
    engine.playCrew(cue({ dwarfId: 'd1', cue: 'walk', gain: 0.05 }))
    engine.setSettings({ ...DEFAULT_AUDIO_PREFERENCES, ambienceVolume: 0.5 })
    expect(crewClips()[0]!.volume).toBeCloseTo(0.25 * 0.05)
  })

  it('leaves the music alone, the crew being the ambience and not the music', () => {
    engine.setMusicOn(true)
    engine.playCrew(cue())
    engine.setAmbienceMuted(true)
    expect(player.liveOf('t1.ogg')).toHaveLength(1)
  })

  it('releases every crew clip on dispose, and opens none afterwards', () => {
    engine.playCrew(cue({ dwarfId: 'd1' }))
    const strike = crewClips()[0]!
    engine.dispose()
    expect(strike.stopped).toBe(true)

    engine.playCrew(cue({ dwarfId: 'd2' }))
    expect(player.live()).toHaveLength(0)
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
      crew: CREW,
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
      crew: CREW,
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
      crew: CREW,
      random: inOrderRandom(),
      now: () => time.now
    })
    engine.setMusicOn(true)
    engine.setScene({ mineId: 'mine-a' })
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
      crew: CREW,
      random: inOrderRandom(),
      now: () => time.now
    })
    engine.dispose()
    engine.setMusicOn(true)
    engine.setScene({ mineId: 'mine-a' })
    engine.playVoice('foreman')
    engine.tick()
    expect(player.clips).toHaveLength(0)
  })
})
