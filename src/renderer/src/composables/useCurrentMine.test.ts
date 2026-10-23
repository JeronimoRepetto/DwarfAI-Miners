// @vitest-environment jsdom
import type { MineId, UiSessionPatch } from '@dwarfai/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shallowRef } from 'vue'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { AMBIENCE_SRC, CREW_SFX_SRC, DWARF_VOICE_SRC, UI_SFX_SRC } from '../lib/audio/audioAssets'
import type { CrewSoundEvent } from '../lib/audio/crew'
import { createFakeAudioPlayer, type FakeAudioPlayer } from '../lib/audio/fakeAudioPlayer'
import type { CurrentMineFacts } from '../lib/valle/currentMine'
import { EREBOR, KHAZAD, MORIA } from '../lib/veta/testing/vetaFixtures'
import { DEFAULT_AUDIO_PREFERENCES, type AudioPreferences } from '../types'
import { useAudio } from './useAudio'
import { useCurrentMine } from './useCurrentMine'

/*
 * The Valle window's current mine and its sound engine (07 machine 35; US-VALLE-013.AC08, US-VALLE-016; UC-060;
 * NFR-SND-02, NFR-SND-07, BR-13; ISSUE-307), over the transplanted `fakeAudioPlayer` (16 §4.14): one value per host,
 * written through A-N18 `current-mine`, is the mine whose room tone, bed and crew play; cues and voices never read it.
 */

const BEDS = new Set<string>(Object.values(AMBIENCE_SRC))
const PICK = CREW_SFX_SRC.worker.strike[0]!

let player: FakeAudioPlayer
let teardown: (() => void)[] = []

beforeEach(() => {
  player = createFakeAudioPlayer()
  stubApi({ ...DEFAULT_AUDIO_PREFERENCES })
})
afterEach(() => {
  for (const stop of teardown) stop()
  teardown = []
})

function stubApi(preferences: AudioPreferences): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: createFakeWindowApi({
      getAudioPreferences: () => Promise.resolve(preferences),
      setAudioPreferences: (next: AudioPreferences) => Promise.resolve(next)
    })
  })
}

/** Valle's engine and its current mine, over a Control room of three columns with no chat in focus. */
async function valleSound(facts: Partial<CurrentMineFacts> = {}) {
  const shown = shallowRef<CurrentMineFacts>({
    preset: 'control',
    mosaic: [MORIA, EREBOR, KHAZAD],
    frontMine: null,
    focusMine: null,
    ...facts
  })
  const muted = shallowRef<readonly MineId[]>([])
  const patches: UiSessionPatch[] = []
  const audio = useAudio({
    player,
    random: () => 0.5,
    music: false,
    panelCue: false,
    visibility: { read: () => Promise.resolve(true), listen: () => () => {} }
  })
  await audio.sync()
  const mine = useCurrentMine({
    bridge: { patchUiSession: (patch) => patches.push(patch) },
    facts: () => shown.value,
    muted: () => muted.value,
    sound: audio
  })
  teardown.push(() => {
    mine.stop()
    audio.dispose()
  })
  return { audio, mine, shown, muted, patches }
}

const beds = () => player.live().filter((clip) => BEDS.has(clip.src))
const picks = () => player.liveOf(PICK)
const strike = (mineId: MineId, dwarfId = `d-${mineId}`): CrewSoundEvent => ({
  mineId,
  dwarfId,
  role: 'worker',
  cue: 'strike'
})

describe('the current mine and what is heard in Valle', () => {
  it('[US-VALLE-013.AC08, NFR-SND-02, BR-13] the sound engine reads exactly the mine Valle marks', async () => {
    const { audio, mine, patches } = await valleSound({ focusMine: EREBOR })
    // The fallback: the chat in focus's column, marked and written for the Valle host alone.
    expect(mine.current.value).toBe(EREBOR)
    expect(patches.at(-1)).toEqual({ kind: 'current-mine', host: 'valle', mineId: EREBOR })
    expect(beds()).toHaveLength(1)
    // Its crew is heard; nobody else's.
    audio.playCrew(strike(MORIA))
    expect(picks()).toHaveLength(0)
    audio.playCrew(strike(EREBOR))
    expect(picks()).toHaveLength(1)
  })

  it("[US-VALLE-016.AC02, S35.01] a change of current mine silences the previous mine's ambience, bed and crew and starts the new one's", async () => {
    const { audio, mine, patches } = await valleSound()
    expect(mine.current.value).toBe(MORIA)
    audio.playCrew(strike(MORIA))
    const before = beds()[0]!
    const pick = picks()[0]!

    expect(mine.send({ kind: 'chat', mineId: KHAZAD })).toBe(true)
    expect(mine.current.value).toBe(KHAZAD)
    expect(patches.at(-1)).toEqual({ kind: 'current-mine', host: 'valle', mineId: KHAZAD })
    // The previous mine's bed and crew are cut, the new mine's bed is a fresh clip.
    expect(before.stopped).toBe(true)
    expect(pick.stopped).toBe(true)
    expect(beds()).toHaveLength(1)
    expect(beds()[0]).not.toBe(before)
    audio.playCrew(strike(KHAZAD))
    expect(picks()).toHaveLength(1)
  })

  it("[US-VALLE-016.AC03] an unfocused mine's picks, grinds and footsteps are never heard", async () => {
    const { audio, mine, muted } = await valleSound()
    mine.send({ kind: 'painting', mineId: EREBOR })
    const opened = player.clips.length
    for (const mineId of [MORIA, KHAZAD]) {
      audio.playCrew(strike(mineId))
      audio.playCrew({ mineId, dwarfId: `g-${mineId}`, role: 'worker2', cue: 'shift' })
      audio.playCrew({ mineId, dwarfId: `w-${mineId}`, role: 'foreman', cue: 'walk' })
    }
    expect(player.clips.length).toBe(opened)
    audio.playCrew(strike(EREBOR))
    expect(picks()).toHaveLength(1)
    // The current mine's own mute silences its bed and its crew as well (S31.08).
    muted.value = [EREBOR]
    expect(beds()).toHaveLength(0)
    audio.playCrew(strike(EREBOR, 'another'))
    expect(picks()).toHaveLength(0)
  })

  it('[US-VALLE-016.AC04, S35.07] a question, a permission or a finished turn plays its cue from any mine', async () => {
    const { audio, mine, muted } = await valleSound()
    mine.send({ kind: 'painting', mineId: KHAZAD })
    muted.value = [KHAZAD]
    for (const kind of ['question', 'permission', 'finished'] as const) {
      audio.playSfx(kind)
      expect(player.liveOf(UI_SFX_SRC[kind])).toHaveLength(1)
    }
    // A cue takes no transition: the current mine stays.
    expect(mine.send({ kind: 'cue' })).toBe(true)
    expect(mine.current.value).toBe(KHAZAD)
  })

  it('[US-VALLE-016.AC05] clicking or selecting any dwarf plays its voice line whatever mine is current', async () => {
    const { audio, mine, muted } = await valleSound()
    mine.send({ kind: 'painting', mineId: EREBOR })
    muted.value = [EREBOR]
    // A dwarf of another mine, and the current mine muted: its voice still plays.
    audio.playVoice('worker2')
    expect(player.liveOf(DWARF_VOICE_SRC.worker2)).toHaveLength(1)
    expect(mine.current.value).toBe(EREBOR)
  })

  it('[US-VALLE-016.AC07, NFR-SND-07] only the Notification sounds switch stops an attention cue', async () => {
    const { audio, mine, muted } = await valleSound()
    // The current mine muted and moved: neither stops a cue.
    muted.value = [MORIA]
    mine.send({ kind: 'painting', mineId: MORIA })
    expect(beds()).toHaveLength(0)
    audio.playSfx('question')
    expect(player.liveOf(UI_SFX_SRC.question)).toHaveLength(1)

    stubApi({ ...DEFAULT_AUDIO_PREFERENCES, notificationSounds: false })
    await audio.sync()
    expect(player.liveOf(UI_SFX_SRC.question)).toHaveLength(0)
    audio.playSfx('permission')
    expect(player.liveOf(UI_SFX_SRC.permission)).toHaveLength(0)
  })
})
