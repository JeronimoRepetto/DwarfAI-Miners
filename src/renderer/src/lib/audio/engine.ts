/**
 * Everything the panel plays, driven by the pure rules beside this file
 * (#174, #173).
 *
 * Framework-agnostic on purpose, like the rest of `lib/`: it holds clips and
 * decides when each one starts, fades and is released, and it does so through
 * an injected player and an injected clock, so the whole of it is exercised by
 * `engine.test.ts` with no timers, no browser and no sound. `useAudio` is the
 * Vue wrapper that feeds it the snapshot, the clicks and a tick; the
 * components decide nothing.
 *
 * ## No timers of its own, deliberately
 *
 * Two things here happen "later": the second of silence between tracks, and
 * releasing a bed once its crossfade has run. Both are recorded as a DEADLINE
 * and settled by `tick()`, rather than each opening a `setTimeout`. That is
 * what makes them testable by advancing a number — and it is also what keeps
 * a stop honest, since a pending timeout would have to be found and cleared by
 * every path that can stop a sound, and there are seven of them.
 *
 * ## The gates are applied twice
 *
 * A gate that shuts stops the sound AND makes its volume zero (see
 * volume.ts). Two answers to one question is usually a smell; here the second
 * is the floor under a bug in the first, and it costs a multiplication.
 */
import type { AudioPreferences, DwarfRole } from '../../types'
import { DEFAULT_AUDIO_PREFERENCES } from '../../types'
import {
  AMBIENCE_CROSSFADE_MS,
  ambienceMove,
  shouldCrossfadeLoopSeam,
  type AmbienceBed,
  type AmbienceStanding
} from './ambience'
import { musicTimeline, MUSIC_GAP_MS } from './musicTimeline'
import type { AudioClip, AudioPlayer } from './player'
import { createPlaylist, type Playlist } from './playlist'
import { channelVolume, type AudioGates } from './volume'

/** What the engine needs to know about the mine on screen. */
export interface AudioScene {
  /** The mine whose interior is open, or null when none is. */
  mineId: string | null
  /** Whether at least one worker in that mine is working (see hasWorkingWorker). */
  working: boolean
}

export interface AudioEngineOptions {
  player: AudioPlayer
  /** The music tracks, in any order — the playlist shuffles them. */
  tracks: readonly string[]
  beds: Record<AmbienceBed, string>
  voices: Record<DwarfRole, string>
  /** Injected so a test can name which track plays. */
  random?: () => number
  /** Injected for the same reason every clock in this repo is. */
  now?: () => number
}

export interface AudioEngine {
  /** Adopt the persisted Audio settings; live sounds follow immediately. */
  setSettings: (settings: AudioPreferences) => void
  /** Whether the app is hidden, and whether the shell is collapsed to its rail. */
  setGates: (gates: AudioGates) => void
  /** The shell's music button: playback for this run. */
  setMusicOn: (on: boolean) => void
  /** The mine on screen and what its crew is doing. */
  setScene: (scene: AudioScene) => void
  /** The interior's mute, which silences the ambience alone. */
  setAmbienceMuted: (muted: boolean) => void
  /** A dwarf was clicked: its rank speaks, once. */
  playVoice: (role: DwarfRole) => void
  /** Settle every deadline and check both seams. Cheap; call it often. */
  tick: () => void
  /** Release every sound. Nothing plays after this. */
  dispose: () => void
}

/** A bed on its way out, and when its crossfade will have finished. */
interface FadingBed {
  clip: AudioClip
  releaseAt: number
}

export function createAudioEngine(options: AudioEngineOptions): AudioEngine {
  const { player, beds, voices } = options
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const playlist: Playlist<string> = createPlaylist(options.tracks, random)

  let settings: AudioPreferences = { ...DEFAULT_AUDIO_PREFERENCES }
  let gates: AudioGates = { hidden: false, collapsed: false }
  let scene: AudioScene = { mineId: null, working: false }
  let ambienceMuted = false
  let disposed = false

  /** The shell button's state for this run; #174 starts it on by default. */
  let musicOn = false
  let music: AudioClip | undefined
  /**
   * Whether the current track's closing fade has been asked for. Held so a
   * 4Hz tick does not re-aim the same ramp forty times across its last second,
   * which would restart it from wherever it had got to and stall the fade.
   */
  let musicFadingOut = false
  /** When the next track starts, or undefined while none is due. */
  let nextTrackAt: number | undefined

  let ambience: { clip: AudioClip; standing: AmbienceStanding } | undefined
  const fading: FadingBed[] = []

  let voice: AudioClip | undefined

  function volumeOf(channel: 'music' | 'ambience' | 'voice'): number {
    return channelVolume(channel, settings, gates)
  }

  // ── music ────────────────────────────────────────────────────────────────

  function startNextTrack(): void {
    const src = playlist.next()
    // Nothing to play: #174 asks for silence rather than a placeholder track.
    if (src === undefined) return
    nextTrackAt = undefined
    musicFadingOut = false
    music = player.open(src, {
      volume: 0,
      // The fallback that makes the gap work for a track whose `duration`
      // never became readable — see musicTimeline on why that is ordinary.
      onEnded: () => {
        if (music === undefined) return
        nextTrackAt = now() + MUSIC_GAP_MS
      }
    })
    music.play()
    music.rampVolume(volumeOf('music'), musicTimeline(music.durationMs()).fadeInMs)
  }

  function stopMusic(): void {
    music?.stop()
    music = undefined
    musicFadingOut = false
    nextTrackAt = undefined
  }

  function tickMusic(): void {
    if (!musicOn || gates.hidden) return
    if (nextTrackAt !== undefined && now() >= nextTrackAt) {
      // The outgoing track has faded out and its second of silence is over.
      music?.stop()
      music = undefined
      startNextTrack()
      return
    }
    if (music === undefined) return
    if (musicFadingOut) return
    const timeline = musicTimeline(music.durationMs())
    if (music.positionMs() < timeline.fadeOutStartMs) return
    musicFadingOut = true
    // Over what is LEFT of the track rather than over a flat second: the tick
    // that notices the seam can be a quarter of a second late, and a fade of
    // the full length would then still be running when the track ended — an
    // audible cut at exactly the moment the fade exists to smooth.
    const remaining = Math.max(0, timeline.endMs - music.positionMs())
    music.rampVolume(0, remaining)
    // The gap follows the track's own END, not the start of its fade.
    nextTrackAt = now() + remaining + MUSIC_GAP_MS
  }

  // ── ambience ─────────────────────────────────────────────────────────────

  function retire(clip: AudioClip, overMs: number): void {
    clip.rampVolume(0, overMs)
    fading.push({ clip, releaseAt: now() + overMs })
  }

  function openBed(standing: AmbienceStanding, volume: number): void {
    const clip = player.open(beds[standing.bed], { volume })
    clip.play()
    ambience = { clip, standing }
  }

  function stopAmbience(): void {
    ambience?.clip.stop()
    ambience = undefined
    // A cut discards the outgoing bed too: it belongs to a mine or a state
    // that is no longer on screen, and letting it finish its fade would be the
    // panel still saying something about it.
    for (const bed of fading) bed.clip.stop()
    fading.length = 0
  }

  function applyAmbience(): void {
    const move = ambienceMove(ambience?.standing ?? null, {
      mineId: scene.mineId,
      working: scene.working,
      muted: ambienceMuted,
      hidden: gates.hidden,
      collapsed: gates.collapsed
    })
    if (move.kind === 'none') return
    if (move.kind === 'stop') {
      stopAmbience()
      return
    }
    if (move.kind === 'cut') {
      stopAmbience()
      openBed({ mineId: move.mineId, bed: move.bed }, volumeOf('ambience'))
      return
    }
    crossfadeTo({ mineId: move.mineId, bed: move.bed }, move.ms)
  }

  /**
   * The one crossfade, shared by the state flip and the loop seam.
   *
   * They are the same act — two seconds of the outgoing bed falling while the
   * incoming one rises — so a flip that lands ON the seam runs once, not
   * twice: whichever of the two got here first leaves `ambience` holding a
   * fresh copy at position 0, and a bed at position 0 has no seam to detect.
   */
  function crossfadeTo(standing: AmbienceStanding, overMs: number): void {
    const outgoing = ambience?.clip
    openBed(standing, 0)
    ambience?.clip.rampVolume(volumeOf('ambience'), overMs)
    if (outgoing) retire(outgoing, overMs)
  }

  function tickAmbience(): void {
    // Walked backwards so a release can splice without skipping its neighbour.
    for (let index = fading.length - 1; index >= 0; index--) {
      const bed = fading[index]
      if (bed === undefined || now() < bed.releaseAt) continue
      bed.clip.stop()
      fading.splice(index, 1)
    }
    if (ambience === undefined) return
    const clip = ambience.clip
    if (!shouldCrossfadeLoopSeam(clip.positionMs(), clip.durationMs())) return
    // The seam plays whichever bed the scene calls for NOW: the same one
    // normally, the other one when the crew changed on this very tick.
    //
    // Nothing is recorded about having run it, and that is the whole of #322:
    // the seam belongs to the bed in `ambience`, and this crossfade replaces
    // that bed with a copy at position 0. A flag remembering "the seam has
    // started" outlived the bed it described, so the copy it faded in was born
    // already seamed and never opened the next one — two plays, then silence.
    // The outgoing bed cannot seam twice either: it is no longer `ambience`,
    // so nothing here reads its position again.
    crossfadeTo(ambience.standing, AMBIENCE_CROSSFADE_MS)
  }

  // ── the surface ──────────────────────────────────────────────────────────

  return {
    setSettings(next: AudioPreferences): void {
      if (disposed) return
      settings = next
      // Re-AIMED rather than written, which is the player's own distinction:
      // a clip mid-fade keeps fading, towards the new value, and a clip that
      // is not fading simply takes it. The one clip deliberately left alone is
      // a track already fading OUT — it is on its way to silence, and aiming
      // it at a slider would be reviving a track that is ending.
      if (!musicFadingOut) music?.retargetVolume(volumeOf('music'))
      ambience?.clip.retargetVolume(volumeOf('ambience'))
    },
    setGates(next: AudioGates): void {
      if (disposed) return
      const wasHidden = gates.hidden
      gates = next
      if (gates.hidden) {
        // PAUSED, not stopped: #174 asks for the music to resume where it was
        // when the panel comes back, which only a preserved position can do.
        music?.pause()
        // A bark, by contrast, is over in a second — resuming half of one
        // when the window returns would be a dwarf speaking at nobody.
        voice?.stop()
        voice = undefined
      } else if (wasHidden && musicOn) {
        // Resumed if there is a track, STARTED if there is not. The second
        // half is the ordinary launch: the window is created hidden and the
        // shell asks for music before anybody can hear it, so nothing was
        // opened — and only being shown can begin the playlist. Treating that
        // as "nothing to resume" is silence for the rest of the run.
        if (music === undefined) startNextTrack()
        else music.play()
      }
      if (!musicFadingOut) music?.retargetVolume(volumeOf('music'))
      applyAmbience()
    },
    setMusicOn(on: boolean): void {
      if (disposed || on === musicOn) return
      musicOn = on
      if (!on) {
        stopMusic()
        return
      }
      if (gates.hidden) return
      startNextTrack()
    },
    setScene(next: AudioScene): void {
      if (disposed) return
      scene = next
      applyAmbience()
    },
    setAmbienceMuted(muted: boolean): void {
      if (disposed) return
      ambienceMuted = muted
      applyAmbience()
    },
    playVoice(role: DwarfRole): void {
      if (disposed) return
      const volume = volumeOf('voice')
      // Nothing to hear, so nothing to decode: a slider at zero must not open
      // a clip, or every click would pay for a sound nobody can hear.
      if (volume <= 0) return
      voice?.stop()
      const clip = player.open(voices[role], {
        volume,
        onEnded: () => {
          clip.stop()
          if (voice === clip) voice = undefined
        }
      })
      voice = clip
      clip.play()
    },
    tick(): void {
      if (disposed) return
      tickMusic()
      tickAmbience()
    },
    dispose(): void {
      disposed = true
      stopMusic()
      stopAmbience()
      voice?.stop()
      voice = undefined
    }
  }
}
