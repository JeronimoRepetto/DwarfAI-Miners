// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioPreferences, Dwarf } from '../types'
import { DEFAULT_AUDIO_PREFERENCES } from '../types'
import { createFakeAudioPlayer, type FakeAudioPlayer } from '../lib/audio/fakeAudioPlayer'
import { AUDIO_TICK_MS, useAudio } from './useAudio'

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
    value: {
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
    }
  })
}

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
    expect(player.live()).toHaveLength(1)
    expect(player.live()[0]!.playing).toBe(true)

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

  it('reads the working bed off the crew the mine is drawing', async () => {
    const surface = audio(player)
    await surface.sync()

    surface.setScene('mine-a', [dwarf({ role: 'foreman', status: 'working' })])
    expect(player.live().some((clip) => clip.src.includes('silence'))).toBe(true)

    surface.setScene('mine-a', [dwarf({ role: 'worker', status: 'working' })])
    expect(player.live().some((clip) => clip.src.includes('working'))).toBe(true)
    surface.dispose()
  })

  it('stops the ambience when the shell collapses to its rail, and keeps the music', async () => {
    const surface = audio(player)
    await surface.sync()
    surface.setScene('mine-a', [dwarf({ status: 'working' })])
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
    surface.setScene('mine-a', [dwarf({ status: 'working' })])
    expect(pushVisibility).toBeDefined()

    ;(pushVisibility as VisibilityListener)(false)
    expect(player.live().filter((clip) => clip.src.includes('mine-inside'))).toHaveLength(0)
    expect(player.live().every((clip) => !clip.playing)).toBe(true)

    ;(pushVisibility as VisibilityListener)(true)
    expect(player.live().some((clip) => clip.playing)).toBe(true)

    stop()
    expect(unsubscribed).toBe(true)
    surface.dispose()
  })

  it('mutes the mine ambience for this run without touching the music', async () => {
    const surface = audio(player)
    await surface.sync()
    surface.setScene('mine-a', [dwarf({ status: 'working' })])

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
    surface.setScene('mine-a', [dwarf({ status: 'working' })])
    surface.playVoice('worker')
    expect(player.live()).toHaveLength(3)

    surface.dispose()
    expect(player.live()).toHaveLength(0)
  })
})
