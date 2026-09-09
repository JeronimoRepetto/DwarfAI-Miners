import { ref } from 'vue'
import type { AudioPreferences, DwarfRole } from '../types'
import { DEFAULT_AUDIO_PREFERENCES, parseAudioPreferences } from '../types'
import {
  AMBIENCE_SRC,
  CREW_SFX_SRC,
  DWARF_VOICE_SRC,
  MUSIC_TRACK_SRC,
  UI_SFX_SRC
} from '../lib/audio/audioAssets'
import type { CrewSoundEvent } from '../lib/audio/crew'
import { createAudioEngine } from '../lib/audio/engine'
import { createElementAudioPlayer, type AudioPlayer } from '../lib/audio/player'
import type { UiSfx } from '../lib/audio/volume'

/**
 * The one place the panel's sound is wired up (#174, #173): the engine, a
 * player, the persisted settings, the window's visibility, and the clicks.
 *
 * Everything that DECIDES anything is below this file — the playlist, the
 * fades, the ambience machine, the volume mixing — and everything that draws
 * anything is above it. What is left here is Vue-shaped: refs the shell's
 * button and Settings render from, the two pulls and the one push that talk to
 * main, and the tick that lets the engine notice a seam.
 *
 * Two facts are deliberately NOT persisted, and both are #174's own ruling.
 * The shell's music button is playback for THIS RUN, because somebody
 * silencing the music for one meeting is not saying what the app should do
 * tomorrow — "music at startup" in Settings is that statement, and it is a
 * different one. The interior's ambience mute is per run for the same reason.
 *
 * No module-scope singleton: the shell window is the only consumer (the
 * message panel's window plays nothing), so per-call refs keep the tests
 * independent without a clearAll() ritual — the same reasoning
 * `usePinnedWindow` gives.
 */

/**
 * How often the engine is asked to look at its seams.
 *
 * Four times a second, which is what the two deadlines actually need: the
 * music's fade-out is ramped over what is LEFT of the track rather than a flat
 * second (see engine.ts), so a tick up to 250 ms late shortens the fade rather
 * than overrunning the end, and the ambience seam starts 2 s before a bed ends
 * and stays due until it does. Nothing here is per-frame work: one `tick()`
 * over at most three clips reads two numbers off each.
 */
export const AUDIO_TICK_MS = 250

export interface UseAudioOptions {
  /** Injected by the tests; the real one is one `Audio` element per clip. */
  player?: AudioPlayer
  random?: () => number
  now?: () => number
}

export function useAudio(options: UseAudioOptions = {}) {
  const settings = ref<AudioPreferences>({ ...DEFAULT_AUDIO_PREFERENCES })
  /** The shell button's state: whether music should be playing this run. */
  const musicPlaying = ref(false)
  /** The mine interior's own mute, which silences the ambience alone. */
  const ambienceMuted = ref(false)

  const engine = createAudioEngine({
    player: options.player ?? createElementAudioPlayer(),
    tracks: MUSIC_TRACK_SRC,
    beds: AMBIENCE_SRC,
    voices: DWARF_VOICE_SRC,
    sfx: UI_SFX_SRC,
    crew: CREW_SFX_SRC,
    random: options.random,
    now: options.now
  })

  let ticker: ReturnType<typeof setInterval> | undefined

  /*
   * The two gates, held HERE rather than read back from the engine, which
   * deliberately answers no questions: each is set by a different event — main
   * pushes the window's visibility, the shell reports its own composition —
   * and either one changing has to restate the other rather than clearing it.
   */
  let hidden = false
  let collapsed = false
  function applyGates(): void {
    engine.setGates({ hidden, collapsed })
  }

  /**
   * Adopt the stored settings and the window's real visibility, then start the
   * music if the settings say it should be playing.
   *
   * A bridge that cannot answer leaves the DEFAULTS in place and still starts,
   * which is the honest reading: the settings are unreachable, not set to off,
   * and the default is on. Silence would be the panel inventing a choice
   * nobody made — the same rule the settings panel follows when it refuses to
   * print a version it could not read.
   */
  async function sync(): Promise<void> {
    try {
      settings.value = parseAudioPreferences(await window.api.getAudioPreferences())
    } catch {
      // The last known settings are still the most honest thing to play at,
      // and the next successful call corrects them.
    }
    engine.setSettings(settings.value)
    try {
      // Asked rather than assumed, because the page loads while the window is
      // still HIDDEN: a renderer that assumed it was on screen would start the
      // music behind a window nobody had opened yet.
      hidden = !(await window.api.getPanelVisible())
      applyGates()
    } catch {
      // An unreachable main is not a hidden window. Assuming it was would mean
      // a silent app with nothing on screen to explain it, and the push
      // corrects this the first time the window is shown or hidden.
    }
    if (settings.value.musicAtStartup) {
      musicPlaying.value = true
      engine.setMusicOn(true)
    }
  }

  /**
   * Keep in step with the world: hear the window being shown or hidden, and
   * give the engine its tick.
   *
   * Both in one call because both are "while this surface is alive", and
   * App.vue has one mount to start them from and one unmount to stop them at.
   * Returns the stop, exactly as `useMessagePanel().listen` does.
   */
  function listen(): () => void {
    const unlisten = window.api.onPanelVisibility((visible) => {
      hidden = !visible
      applyGates()
    })
    ticker = setInterval(() => engine.tick(), AUDIO_TICK_MS)
    return () => {
      unlisten()
      if (ticker !== undefined) clearInterval(ticker)
      ticker = undefined
    }
  }

  /** The shell's music button. */
  function toggleMusic(): void {
    musicPlaying.value = !musicPlaying.value
    engine.setMusicOn(musicPlaying.value)
  }

  /** The mine interior's mute icon. */
  function toggleAmbienceMute(): void {
    ambienceMuted.value = !ambienceMuted.value
    engine.setAmbienceMuted(ambienceMuted.value)
  }

  /**
   * Persist a change from Settings and adopt what main STORED — never the
   * request. Main clamps every volume, so a slider is only ever drawn at a
   * value really in force; the same honesty rule the pin and the layout
   * surfaces hold.
   */
  async function setSettings(patch: Partial<AudioPreferences>): Promise<void> {
    const requested = parseAudioPreferences({ ...settings.value, ...patch })
    try {
      settings.value = parseAudioPreferences(await window.api.setAudioPreferences(requested))
    } catch {
      // The failed write may or may not have reached main; the last known
      // settings are what the sliders keep showing until a later call answers.
      return
    }
    engine.setSettings(settings.value)
  }

  /**
   * The mine on screen (#173), and since #330 that is all it is.
   *
   * It used to carry the crew as well, because the bed was a reading of what
   * the crew was doing. The crew sounds for itself now — see `playCrew` — so
   * what is left is the room tone, and the mine is the only thing that decides
   * it. The scene is still the one thing a crew cue is checked against, which
   * is why it is set here rather than inferred anywhere below.
   */
  function setScene(mineId: string | null): void {
    engine.setScene({ mineId })
  }

  /** Whether the shell is drawn as its bare rail; only the music survives it. */
  function setCollapsed(next: boolean): void {
    collapsed = next
    applyGates()
  }

  /** A dwarf was clicked (#173): its rank speaks, once. */
  function playVoice(role: DwarfRole): void {
    engine.playVoice(role)
  }

  /**
   * The interface answering a press (#323): a navigation button, or the
   * secondary panel opening or closing.
   *
   * Which press makes which sound is App.vue's, exactly as which dwarf speaks
   * is: this only hands the intent down. Whether it is audible at all belongs
   * to the engine and to `volume.ts` — the Effects slider, the window's
   * visibility, and the one exception the collapsed rail makes for the panel.
   */
  function playSfx(kind: UiSfx): void {
    engine.playSfx(kind)
  }

  /**
   * A crew member's drawing did something audible (#330), forwarded by
   * MineScene from the sprite that drew it.
   *
   * Hands the intent down and nothing else, exactly as `playVoice` does: WHEN
   * a dwarf strikes is the sprite's answer, read off the frames it declares;
   * whether it can be heard, how loud, and how many at once belong to the
   * engine and to `lib/audio/`.
   */
  function playCrew(event: CrewSoundEvent): void {
    engine.playCrew(event)
  }

  /** Release every sound and stop the tick. */
  function dispose(): void {
    if (ticker !== undefined) clearInterval(ticker)
    ticker = undefined
    engine.dispose()
  }

  return {
    settings,
    musicPlaying,
    ambienceMuted,
    sync,
    listen,
    toggleMusic,
    toggleAmbienceMute,
    setSettings,
    setScene,
    setCollapsed,
    playVoice,
    playSfx,
    playCrew,
    dispose
  }
}
