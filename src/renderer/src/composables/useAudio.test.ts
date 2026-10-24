// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import type { AudioPreferences } from '../types'
import { DEFAULT_AUDIO_PREFERENCES } from '../types'
import { createFakeAudioPlayer, type FakeAudioPlayer } from '../lib/audio/fakeAudioPlayer'
import type { UiSessionMusic } from '@dwarfai/contracts'
import { MUSIC_TRACK_SRC } from '../lib/audio/audioAssets'
import { AUDIO_TICK_MS, useAudio, type AudioVisibility, type MusicSession } from './useAudio'

type VisibilityListener = (visible: boolean) => void

interface StubApi {
  getAudioPreferences?: () => Promise<AudioPreferences>
  setAudioPreferences?: (preferences: AudioPreferences) => Promise<AudioPreferences>
  getPanelVisible?: () => Promise<boolean>
  onPanelVisibility?: (listener: VisibilityListener) => () => void
}

let pushVisibility: VisibilityListener | undefined
let unsubscribed = false

function stubApi(api: StubApi = {}): void {
  pushVisibility = undefined
  unsubscribed = false
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: createFakeWindowApi({
      getAudioPreferences: () => Promise.resolve({ ...DEFAULT_AUDIO_PREFERENCES }),
      setAudioPreferences: (preferences: AudioPreferences) => Promise.resolve(preferences),
      getPanelVisible: () => Promise.resolve(true),
      onPanelVisibility: (listener: VisibilityListener) => {
        pushVisibility = listener
        return () => {
          unsubscribed = true
        }
      },
      ...api
    })
  })
}

/*
 * REMOVED for #330: the `dwarf` factory this file used to build a crew with.
 * `setScene` took the crew because the ambience bed was a reading of it; it
 * takes the mine alone now, and no case here has a dwarf to make. No test went
 * with it — it was a helper, and what the crew sounds like is covered a layer
 * down, in `engine.test.ts` and `lib/sprite/crewSound.test.ts`.
 */

/** The tracks and beds are real asset URLs; a test only ever counts clips. */
function audio(player: FakeAudioPlayer) {
  return useAudio({ player, random: () => 0.5 })
}

describe('useAudio', () => {
  let player: FakeAudioPlayer

  beforeEach(() => {
    vi.useFakeTimers()
    player = createFakeAudioPlayer()
    stubApi()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('adopts the stored settings and starts the music when it should start', async () => {
    const surface = audio(player)
    await surface.sync()
    expect(surface.settings.value).toEqual(DEFAULT_AUDIO_PREFERENCES)
    expect(surface.musicPlaying.value).toBe(true)
    expect(player.live()).toHaveLength(1)
    surface.dispose()
  })

  it('stays silent on startup when the person turned that off', async () => {
    stubApi({
      getAudioPreferences: () =>
        Promise.resolve({ ...DEFAULT_AUDIO_PREFERENCES, musicAtStartup: false })
    })
    const surface = audio(player)
    await surface.sync()
    expect(surface.musicPlaying.value).toBe(false)
    expect(player.clips).toHaveLength(0)
    surface.dispose()
  })

  it('keeps the defaults when the bridge cannot answer, and still plays', async () => {
    // Silence would be the worse failure: the settings are unreachable, not
    // set to off, and the default is on.
    stubApi({ getAudioPreferences: () => Promise.reject(new Error('bridge is gone')) })
    const surface = audio(player)
    await surface.sync()
    expect(surface.settings.value).toEqual(DEFAULT_AUDIO_PREFERENCES)
    expect(player.live()).toHaveLength(1)
    surface.dispose()
  })

  it('starts silent when main says the window is not on screen yet', async () => {
    stubApi({ getPanelVisible: () => Promise.resolve(false) })
    const surface = audio(player)
    await surface.sync()
    // The button is on — it is the WINDOW that is away — so the music starts
    // by itself the moment the panel is shown. Which is the ordinary launch:
    // main creates this window hidden.
    expect(surface.musicPlaying.value).toBe(true)
    expect(player.live()).toHaveLength(0)

    const stop = surface.listen()
    ;(pushVisibility as VisibilityListener)(true)
    // AMENDED for #635 (PANEL-QUESTIONS Q22): the show now also sounds the
    // panel cue, so the music is counted apart from it; the claim is unchanged.
    const music = player.live().filter((clip) => !clip.src.includes('panel-open-close'))
    expect(music).toHaveLength(1)
    expect(music[0]!.playing).toBe(true)

    stop()
    surface.dispose()
  })

  it('toggles playback for this run without persisting anything', async () => {
    const setAudioPreferences = vi.fn()
    stubApi({ setAudioPreferences })
    const surface = audio(player)
    await surface.sync()

    surface.toggleMusic()
    expect(surface.musicPlaying.value).toBe(false)
    expect(player.live()).toHaveLength(0)

    surface.toggleMusic()
    expect(surface.musicPlaying.value).toBe(true)
    expect(player.live()).toHaveLength(1)
    // #174: the shell button is about this run. "Music at startup" is the
    // stored fact, and the button is not it.
    expect(setAudioPreferences).not.toHaveBeenCalled()
    surface.dispose()
  })

  it('renders the settings main stored, never the ones that were asked for', async () => {
    stubApi({
      setAudioPreferences: () => Promise.resolve({ ...DEFAULT_AUDIO_PREFERENCES, musicVolume: 1 })
    })
    const surface = audio(player)
    await surface.sync()
    await surface.setSettings({ musicVolume: 4 })
    expect(surface.settings.value.musicVolume).toBe(1)
    surface.dispose()
  })

  it('keeps the last known settings when a change cannot be persisted', async () => {
    stubApi({ setAudioPreferences: () => Promise.reject(new Error('bridge is gone')) })
    const surface = audio(player)
    await surface.sync()
    await surface.setSettings({ musicVolume: 0.5 })
    expect(surface.settings.value).toEqual(DEFAULT_AUDIO_PREFERENCES)
    surface.dispose()
  })

  /*
   * AMENDED for #330. It read 'reads the working bed off the crew the mine is
   * drawing' and asserted that a mine with only a foreman got `silence` while
   * a mine with a working worker got the `working` bed. That bed is retired —
   * the crew makes the mine's noise itself now — so the room tone is the same
   * whoever is inside, and what is worth pinning here is exactly that.
   */
  it('plays the one room tone for an interior, whoever is inside it', async () => {
    const surface = audio(player)
    await surface.sync()

    surface.setScene('mine-a')
    // AMENDED for #637: the room tone's file is `mine-inside-room-tone` now,
    // renamed with its replacement; it read `silence`, the old file's name.
    expect(player.live().some((clip) => clip.src.includes('room-tone'))).toBe(true)
    expect(player.live().some((clip) => clip.src.includes('mine-inside-working'))).toBe(false)
    surface.dispose()
  })

  it('plays a crew cue through the engine, on the ambience channel (#330)', async () => {
    const surface = audio(player)
    await surface.sync()
    surface.setScene('mine-a')

    surface.playCrew({ mineId: 'mine-a', dwarfId: 'd1', role: 'worker', cue: 'strike' })
    expect(player.live().some((clip) => clip.src.includes('pickaxe'))).toBe(true)
    surface.dispose()
  })

  it('opens nothing for a cue from a mine that is not on screen', async () => {
    const surface = audio(player)
    await surface.sync()
    surface.setScene('mine-a')
    const before = player.clips.length

    surface.playCrew({ mineId: 'mine-b', dwarfId: 'd1', role: 'worker', cue: 'strike' })
    expect(player.clips).toHaveLength(before)
    surface.dispose()
  })

  it('stops the ambience when the shell collapses to its rail, and keeps the music', async () => {
    const surface = audio(player)
    await surface.sync()
    surface.setScene('mine-a')
    const beds = () => player.live().filter((clip) => clip.src.includes('mine-inside'))
    expect(beds()).toHaveLength(1)

    surface.setCollapsed(true)
    expect(beds()).toHaveLength(0)
    expect(player.live()).toHaveLength(1)
    surface.dispose()
  })

  it('goes silent on the push that says the window went away, and comes back', async () => {
    const surface = audio(player)
    await surface.sync()
    const stop = surface.listen()
    surface.setScene('mine-a')
    expect(pushVisibility).toBeDefined()

    ;(pushVisibility as VisibilityListener)(false)
    expect(player.live().filter((clip) => clip.src.includes('mine-inside'))).toHaveLength(0)
    // AMENDED for #635 (PANEL-QUESTIONS Q22): every clip but the close cue. The
    // hide now sounds the panel cue, and that one plays out across the hide.
    expect(
      player
        .live()
        .filter((clip) => !clip.src.includes('panel-open-close'))
        .every((clip) => !clip.playing)
    ).toBe(true)

    ;(pushVisibility as VisibilityListener)(true)
    expect(player.live().some((clip) => clip.playing)).toBe(true)

    stop()
    expect(unsubscribed).toBe(true)
    surface.dispose()
  })

  it('mutes the mine ambience for this run without touching the music', async () => {
    const surface = audio(player)
    await surface.sync()
    surface.setScene('mine-a')

    surface.toggleAmbienceMute()
    expect(surface.ambienceMuted.value).toBe(true)
    expect(player.live().filter((clip) => clip.src.includes('mine-inside'))).toHaveLength(0)
    expect(player.live()).toHaveLength(1)
    expect(player.live()[0]!.playing).toBe(true)

    surface.toggleAmbienceMute()
    expect(surface.ambienceMuted.value).toBe(false)
    expect(player.live().filter((clip) => clip.src.includes('mine-inside'))).toHaveLength(1)
    surface.dispose()
  })

  it('plays a clicked dwarf its rank voice', async () => {
    const surface = audio(player)
    await surface.sync()
    surface.playVoice('foreman')
    expect(player.live().some((clip) => clip.src.includes('foreman'))).toBe(true)
    surface.dispose()
  })

  it('answers a navigation press and the panel with their own recordings (#323)', async () => {
    const surface = audio(player)
    await surface.sync()

    // AMENDED for #637: `button_sound` and `open_sound` were renamed `ui-click`
    // and `panel-open-close` with their replacements; the claim is unchanged.
    surface.playSfx('click')
    expect(player.live().some((clip) => clip.src.includes('ui-click'))).toBe(true)

    surface.playSfx('panel')
    expect(player.live().some((clip) => clip.src.includes('panel-open-close'))).toBe(true)
    surface.dispose()
  })

  it('still sounds the press that opens the panel from the collapsed rail (#323)', async () => {
    // The rail is the one place an interface sound survives the collapse, and
    // this is the surface that has to carry the exception through.
    const surface = audio(player)
    await surface.sync()
    surface.setCollapsed(true)

    // AMENDED for #637: the two interface files were renamed, as above.
    surface.playSfx('click')
    expect(player.live().some((clip) => clip.src.includes('ui-click'))).toBe(false)

    surface.playSfx('panel')
    expect(player.live().some((clip) => clip.src.includes('panel-open-close'))).toBe(true)
    surface.dispose()
  })

  describe('the panel cue on show and hide (#635, PANEL-QUESTIONS Q22)', () => {
    const panelCues = () => player.clips.filter((clip) => clip.src.includes('panel-open-close'))

    it('sounds once as the window is shown and once as it is hidden', async () => {
      stubApi({ getPanelVisible: () => Promise.resolve(false) })
      const surface = audio(player)
      await surface.sync()
      const stop = surface.listen()

      ;(pushVisibility as VisibilityListener)(true)
      expect(panelCues()).toHaveLength(1)
      expect(panelCues()[0]!.playing).toBe(true)

      // Main publishes on show, restore and the rest; a second push saying the
      // same thing is not a second transition.
      ;(pushVisibility as VisibilityListener)(true)
      expect(panelCues()).toHaveLength(1)

      ;(pushVisibility as VisibilityListener)(false)
      expect(panelCues()).toHaveLength(2)
      // Audible although the window is going: it plays out across the hide.
      expect(panelCues()[1]!.playing).toBe(true)
      expect(panelCues()[1]!.stopped).toBe(false)

      ;(pushVisibility as VisibilityListener)(false)
      expect(panelCues()).toHaveLength(2)

      stop()
      surface.dispose()
    })

    it('makes no cue for the visibility the window starts in', async () => {
      stubApi({ getPanelVisible: () => Promise.resolve(false) })
      const hiddenAtStart = audio(player)
      await hiddenAtStart.sync()
      const stopHidden = hiddenAtStart.listen()
      expect(panelCues()).toHaveLength(0)
      stopHidden()
      hiddenAtStart.dispose()

      stubApi({ getPanelVisible: () => Promise.resolve(true) })
      const shownAtStart = audio(player)
      await shownAtStart.sync()
      const stopShown = shownAtStart.listen()
      expect(panelCues()).toHaveLength(0)
      stopShown()
      shownAtStart.dispose()
    })
  })

  it('drives the engine on a tick, so the fades and seams happen at all', async () => {
    const surface = audio(player)
    await surface.sync()
    const stop = surface.listen()
    const track = player.live()[0]!
    player.settleRamps()
    track.setDurationMs(180_000)
    track.seekMs(179_500)

    vi.advanceTimersByTime(AUDIO_TICK_MS)
    expect(track.ramp?.to).toBe(0)

    stop()
    surface.dispose()
  })

  it('stops ticking once it has been disposed', async () => {
    const surface = audio(player)
    await surface.sync()
    const stop = surface.listen()
    const track = player.live()[0]!
    track.setDurationMs(180_000)
    track.seekMs(179_500)

    surface.dispose()
    stop()
    vi.advanceTimersByTime(AUDIO_TICK_MS * 4)
    expect(track.stopped).toBe(true)
  })

  it('releases every sound on dispose', async () => {
    const surface = audio(player)
    await surface.sync()
    surface.setScene('mine-a')
    surface.playVoice('worker')
    expect(player.live()).toHaveLength(3)

    surface.dispose()
    expect(player.live()).toHaveLength(0)
  })

  /*
   * ISSUE-117: the attention cue composable plays only while this window is the shown mode window (ADR-018 item 8),
   * so the one place that hears the window being shown or hidden says so, rather than a second listener restating it.
   */
  it('[NFR-SND-07] says whether this window is shown, as read at sync and as every push restates it', async () => {
    stubApi({ getPanelVisible: () => Promise.resolve(false) })
    const surface = audio(player)
    await surface.sync()
    const stop = surface.listen()
    expect(surface.windowShown.value).toBe(false)

    pushVisibility!(true)
    expect(surface.windowShown.value).toBe(true)
    pushVisibility!(false)
    expect(surface.windowShown.value).toBe(false)

    stop()
    surface.dispose()
  })

  /*
   * APPENDED for ISSUE-307 (US-VALLE-016; 07 S35.08): the Valle window has its own engine, the window's own visibility
   * as its gate (the Panel's A-P1 push says nothing about Valle), no Panel cue, no music, and a mine's mute set from
   * outside (the zone menu's `mutedMineIds`, read for the current mine).
   */
  it('[S35.08, NFR-SND-07] a window that reads its own visibility plays nothing while hidden and its current mine again when shown', async () => {
    let visible = false
    let push: ((shown: boolean) => void) | undefined
    const surface = useAudio({
      player,
      random: () => 0.5,
      music: false,
      panelCue: false,
      visibility: {
        read: () => Promise.resolve(visible),
        listen: (listener) => {
          push = listener
          return () => {
            push = undefined
          }
        }
      }
    })
    await surface.sync()
    const stop = surface.listen()
    surface.setScene('mine-a')
    // Hidden: nothing, music included, whatever the Panel's own push says.
    expect(player.live()).toHaveLength(0)
    expect(surface.windowShown.value).toBe(false)
    pushVisibility?.(true)
    expect(player.live()).toHaveLength(0)

    visible = true
    push!(true)
    // The room tone alone: no music, no Panel cue.
    expect(player.live()).toHaveLength(1)
    push!(false)
    expect(player.live()).toHaveLength(0)
    // No Panel cue on either side of the hide or the show.
    push!(true)
    expect(player.live()).toHaveLength(1)

    surface.setAmbienceMuted(true)
    expect(player.live()).toHaveLength(0)
    surface.setAmbienceMuted(false)
    expect(player.live()).toHaveLength(1)

    stop()
    expect(push).toBeUndefined()
    surface.dispose()
  })

  /*
   * APPENDED for AMENDMENT-28 (owner ruling 2026-10-24: "one music, one playlist"; music in Veta). Each mode window has
   * its own engine; the music moves between them through the UI-main session store. The window a run leaves writes
   * where its music was and stops it; the window the run enters adopts it. Only the first window of the run reads
   * "Music at startup".
   */
  describe('one music across the mode windows (owner ruling 2026-10-24)', () => {
    /** The UI-main session store's music slot, shared by every window of the run. */
    function sharedStore(): MusicSession & { music: UiSessionMusic | undefined } {
      const store = {
        music: undefined as UiSessionMusic | undefined,
        read: () =>
          Promise.resolve(store.music === undefined ? undefined : structuredClone(store.music)),
        write: (music: UiSessionMusic) => {
          store.music = structuredClone(music)
        }
      }
      return store
    }

    /** A mode window's own shown state (Valle's and Veta's), pushed by the test. */
    function shownState(initial: boolean): AudioVisibility & { set(shown: boolean): void } {
      let shown = initial
      let listener: ((visible: boolean) => void) | undefined
      return {
        read: () => Promise.resolve(shown),
        listen: (next) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
        set(next) {
          shown = next
          listener?.(next)
        }
      }
    }

    function music<T extends { src: string }>(clips: readonly T[]): T[] {
      return clips.filter((clip) => (MUSIC_TRACK_SRC as readonly string[]).includes(clip.src))
    }

    it('[US-SHELL-005.AC03, NFR-SND-07] the window a run enters plays the same track from where the window it left was, in the same order', async () => {
      const session = sharedStore()
      const panelPlayer = createFakeAudioPlayer()
      const vallePlayer = createFakeAudioPlayer()
      const valleShown = shownState(false)
      const panel = useAudio({ player: panelPlayer, random: () => 0.5, session })
      // Valle shuffles with another draw: what it plays must be the Panel's all the same.
      const valle = useAudio({
        player: vallePlayer,
        random: () => 0,
        session,
        visibility: valleShown,
        panelCue: false
      })
      await panel.sync()
      await valle.sync()
      const stopValle = valle.listen()
      expect(music(vallePlayer.live())).toHaveLength(0)
      const track = music(panelPlayer.live())[0]!
      track.seekMs(73_400)

      // The run to Valle: the Panel leaves at once; at t0 Valle enters and is shown.
      panel.leave()
      expect(music(panelPlayer.live())).toHaveLength(0)
      const entered = valle.enter()
      valleShown.set(true)
      await entered

      const playing = music(vallePlayer.live())
      expect(playing.map((clip) => [clip.src, clip.positionMs()])).toEqual([[track.src, 73_400]])
      expect(playing[0]!.playing).toBe(true)
      expect(valle.musicPlaying.value).toBe(true)
      // The rest of the round is the Panel's order.
      expect(session.music!.queue).toHaveLength(MUSIC_TRACK_SRC.length - 1)
      const order = [...session.music!.queue]
      playing[0]!.end()
      vi.advanceTimersByTime(1000 + AUDIO_TICK_MS)
      expect(music(vallePlayer.live()).map((clip) => clip.src)).toEqual([order[0]])

      // And back: the Panel takes up what Valle was playing, not what it had itself.
      music(vallePlayer.live())[0]!.seekMs(2_000)
      valle.leave()
      valleShown.set(false)
      await panel.enter()
      expect(music(panelPlayer.live()).map((clip) => [clip.src, clip.positionMs()])).toEqual([
        [order[0], 2_000]
      ])
      expect(music([...panelPlayer.live(), ...vallePlayer.live()])).toHaveLength(1)
      stopValle()
      panel.dispose()
      valle.dispose()
    })

    it('[US-SHELL-005.AC02] music the person stopped stays stopped in every window, until they start it again', async () => {
      const session = sharedStore()
      const panelPlayer = createFakeAudioPlayer()
      const vetaPlayer = createFakeAudioPlayer()
      const vetaShown = shownState(false)
      const panel = useAudio({ player: panelPlayer, random: () => 0.5, session })
      const veta = useAudio({ player: vetaPlayer, session, visibility: vetaShown, panelCue: false })
      await panel.sync()
      await veta.sync()
      panel.toggleMusic()
      panel.leave()
      const entered = veta.enter()
      vetaShown.set(true)
      await entered
      expect(veta.musicPlaying.value).toBe(false)
      expect(music(vetaPlayer.clips)).toHaveLength(0)
      // A later show of the same window does not read "Music at startup" again.
      vetaShown.set(false)
      vetaShown.set(true)
      await veta.sync()
      expect(music(vetaPlayer.clips)).toHaveLength(0)

      veta.toggleMusic()
      expect(music(vetaPlayer.live())).toHaveLength(1)
      panel.dispose()
      veta.dispose()
    })

    it('[US-SHELL-005.AC01] the first window of the run reads Music at startup; a window shown again keeps its own music', async () => {
      const session = sharedStore()
      const valleShown = shownState(true)
      const valle = useAudio({
        player,
        random: () => 0.5,
        session,
        visibility: valleShown,
        panelCue: false
      })
      await valle.sync()
      const first = music(player.live())[0]!
      first.seekMs(30_000)
      // An older hand-over in the store is not adopted on a minimise and restore: this window holds the music.
      session.write({
        on: true,
        track: MUSIC_TRACK_SRC[0]!,
        positionMs: 5,
        queue: [],
        lastPlayed: null
      })
      valleShown.set(false)
      valleShown.set(true)
      await valle.sync()
      expect(music(player.live())).toEqual([first])
      expect(first.positionMs()).toBe(30_000)
      valle.dispose()
    })

    it('[NFR-SND-07] a window that left plays nothing on a later show until it enters again', async () => {
      const session = sharedStore()
      const panel = useAudio({ player, random: () => 0.5, session })
      await panel.sync()
      const stop = panel.listen()
      panel.leave()
      ;(pushVisibility as VisibilityListener)(false)
      ;(pushVisibility as VisibilityListener)(true)
      vi.advanceTimersByTime(AUDIO_TICK_MS * 4)
      expect(music(player.live())).toHaveLength(0)
      expect(session.music?.on).toBe(true)
      stop()
      panel.dispose()
    })
  })
})
