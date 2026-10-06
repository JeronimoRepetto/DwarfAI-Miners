// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DwarfId, HostFrame, HostFrames } from '@dwarfai/contracts'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { UI_SFX_SRC } from '../lib/audio/audioAssets'
import { createFakeAudioPlayer, type FakeAudioPlayer } from '../lib/audio/fakeAudioPlayer'
import type { AttentionSfx } from '../lib/audio/volume'
import { sceneDwarfStatus } from '../lib/scene/sceneDwarf'
import { needsYouCount } from '../lib/shell/panelNav'
import { defaultDwarf, defaultMine } from '../testing/factories'
import type {
  AudioPreferences,
  Dwarf,
  DwarfPermissionRequest,
  DwarfQuestion,
  Mine,
  TurnOutcome
} from '../types'
import { DEFAULT_AUDIO_PREFERENCES } from '../types'
import { useAttentionCues } from './useAttentionCues'
import { useAudio } from './useAudio'
import { useMines } from './useMines'

/*
 * LEVEL 2 IN THE RENDERER (ISSUE-117; ADR-018 items 1 and 8, ADR-021 item 3).
 *
 * The cue composable against the real sound composable and engine, with the transplanted `fakeAudioPlayer` standing
 * in for the `Audio` elements and the fake `window.api` generated from the registry (17 §1.6). The board is fed the
 * way cut 1 feeds it (today's A-12/A-P2 snapshot through `useMines().setMines`, whose asks come from
 * `LegacyAskRelay` and carry no `reannounce`), and `turn.ended` (B-F14) arrives as an A-N02 batch.
 */

type Api = ReturnType<typeof createFakeWindowApi>

interface Harness {
  player: FakeAudioPlayer
  audio: ReturnType<typeof useAudio>
  /** UI main's visibility push (A-06's sibling `onPanelVisibility`). */
  show(visible: boolean): void
  /** One A-N02 batch. */
  push(frames: HostFrame[]): void
  /** Every `setNotificationsEnabled` call: System notifications (US-SET-006). */
  systemNotificationWrites: boolean[]
  /** Every `setAudioPreferences` call, as sent. */
  audioWrites: AudioPreferences[]
}

let harness: Harness
let stopCues: (() => void) | undefined
let stopAudio: (() => void) | undefined

function question(toolUseId: string): DwarfQuestion {
  return {
    toolUseId,
    channel: 'held',
    questions: [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [] }]
  } as DwarfQuestion
}

function permission(toolUseId: string): DwarfPermissionRequest {
  return {
    toolUseId,
    toolName: 'Bash',
    input: 'ls',
    channel: 'held',
    askedAt: '2026-09-27T10:00:00.000Z'
  }
}

function turn(endedAt: number, extra: Partial<TurnOutcome> = {}): TurnOutcome {
  return { kind: 'concluded', endedAt, ...extra }
}

/** A Host dwarf id is a UUIDv7 (14 §3.6): a `turn.ended` with any other id is not a B-F14 payload. */
const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId

const MINE_A = 'C:/dev/a'
const MINE_B = 'C:/dev/b'

/** Today's feed writes the whole board, a new array every time, exactly as a poll re-renders it. */
function board(...dwarfs: Dwarf[]): void {
  const mines: Mine[] = [
    defaultMine({ id: MINE_A, path: MINE_A, name: 'a', dwarfs }),
    defaultMine({ id: MINE_B, path: MINE_B, name: 'b', dwarfs: [] })
  ]
  useMines().setMines({ mines, tokensObserved: 0 })
}

function turnEnded(seq: number, data: HostFrames['turn.ended']): HostFrame {
  return { type: 'evt', seq, epoch: 'epoch-1', name: 'turn.ended', data } as HostFrame
}

/** The cue clips of one kind ever opened, oldest first. */
function cues(kind: AttentionSfx): FakeAudioPlayer['clips'] {
  return harness.player.clips.filter((clip) => clip.src === UI_SFX_SRC[kind])
}

function allCues(): number {
  return cues('question').length + cues('permission').length + cues('finished').length
}

async function mount(preferences: Partial<AudioPreferences> = {}): Promise<void> {
  const player = createFakeAudioPlayer()
  let visibility: ((visible: boolean) => void) | null = null
  let frames: ((batch: HostFrame[]) => void) | null = null
  const systemNotificationWrites: boolean[] = []
  const audioWrites: AudioPreferences[] = []
  const api = createFakeWindowApi({
    getAudioPreferences: vi.fn(() =>
      Promise.resolve({ ...DEFAULT_AUDIO_PREFERENCES, musicAtStartup: false, ...preferences })
    ) as unknown as Api['getAudioPreferences'],
    setAudioPreferences: vi.fn((next: AudioPreferences) => {
      audioWrites.push(next)
      return Promise.resolve(next)
    }) as unknown as Api['setAudioPreferences'],
    getPanelVisible: vi.fn(() => Promise.resolve(true)) as unknown as Api['getPanelVisible'],
    onPanelVisibility: vi.fn((listener: (visible: boolean) => void) => {
      visibility = listener
      return () => {
        visibility = null
      }
    }) as unknown as Api['onPanelVisibility'],
    onHostEvent: vi.fn((listener: (batch: HostFrame[]) => void) => {
      frames = listener
      return () => {
        frames = null
      }
    }) as unknown as Api['onHostEvent'],
    setNotificationsEnabled: vi.fn((next: boolean) => {
      systemNotificationWrites.push(next)
      return Promise.resolve(next)
    }) as unknown as Api['setNotificationsEnabled']
  })
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  const audio = useAudio({ player, random: () => 0.5 })
  await audio.sync()
  stopAudio = audio.listen()
  harness = {
    player,
    audio,
    show(visible) {
      if (visibility === null) throw new Error('nothing follows onPanelVisibility')
      visibility(visible)
    },
    push(batch) {
      if (frames === null) throw new Error('nothing follows onHostEvent')
      frames(batch)
    },
    systemNotificationWrites,
    audioWrites
  }
  stopCues = useAttentionCues().start(audio)
}

describe('useAttentionCues', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useMines().stop()
    useMines().clear()
  })

  afterEach(() => {
    stopCues?.()
    stopCues = undefined
    stopAudio?.()
    stopAudio = undefined
    harness?.audio.dispose()
    useMines().stop()
    useMines().clear()
    vi.useRealTimers()
  })

  it('[US-MINE-003.AC03, US-ASK-006.AC02] a new ask plays the attention cue exactly once, never again for the same ask whatever mode or mine has focus', async () => {
    await mount()
    // The board the window starts on is where it began looking: nothing on it began now.
    board(defaultDwarf({ id: 'd1', status: 'working' }))
    expect(allCues()).toBe(0)

    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }))
    expect(cues('question')).toHaveLength(1)
    expect(cues('question')[0]!.playing).toBe(true)

    // The same ask, re-rendered by every poll, with the focus moved between mines and modes.
    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }))
    harness.audio.setScene(MINE_B)
    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }))
    harness.audio.setCollapsed(true) // the Panel closed to Veta
    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }))
    harness.audio.setCollapsed(false)
    harness.audio.setScene(MINE_A)
    harness.show(false)
    harness.show(true)
    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }))
    // Gone for one poll and back with the same id is still the same ask.
    board(defaultDwarf({ id: 'd1', status: 'working' }))
    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }))
    expect(cues('question')).toHaveLength(1)
  })

  it("[US-MINE-003.AC05, US-MINE-007.AC04] a muted mine ambience never silences its dwarf's attention cue", async () => {
    await mount()
    harness.audio.setScene(MINE_A)
    harness.audio.toggleAmbienceMute()
    expect(harness.audio.ambienceMuted.value).toBe(true)
    board(defaultDwarf({ id: 'd1', status: 'working' }))

    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingPermission: permission('ask-p') }))
    expect(cues('permission')).toHaveLength(1)
    expect(cues('permission')[0]!.playing).toBe(true)
    expect(cues('permission')[0]!.volume).toBeGreaterThan(0)
  })

  it('[US-SHELL-010.AC01, US-MINE-003.AC04] the asking pose, the question mark and the badge show with the setting off and with the mine or the Panel not on screen', async () => {
    await mount({ notificationSounds: false })
    harness.audio.setScene(null) // the mine is not on screen
    harness.show(false) // nor is the Panel
    board(defaultDwarf({ id: 'd1', status: 'working' }))

    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }))
    const asking = useMines().state.mines[0]!.dwarfs[0]!
    expect(sceneDwarfStatus(asking)).toBe('asking') // the pose and its "?"
    expect(needsYouCount(useMines().state.mines)).toBe(1) // the badge
    expect(allCues()).toBe(0)

    // A need that began unheard is not announced late: showing the window and turning the setting on plays nothing
    // for it, while the next need that begins is heard.
    harness.show(true)
    await harness.audio.setSettings({ notificationSounds: true })
    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }))
    expect(allCues()).toBe(0)
    board(
      defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }),
      defaultDwarf({ id: 'd2', status: 'waiting', pendingQuestion: question('ask-2') })
    )
    expect(cues('question')).toHaveLength(1)
  })

  it('[US-SET-005.AC02] with notification sounds off the ask still shows exactly as with the setting on', async () => {
    const shown: unknown[] = []
    const heard: number[] = []
    for (const notificationSounds of [true, false]) {
      await mount({ notificationSounds })
      board(defaultDwarf({ id: 'd1', status: 'working' }))
      board(defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }))
      const mines = useMines().state.mines
      shown.push({
        board: JSON.parse(JSON.stringify(mines)),
        pose: sceneDwarfStatus(mines[0]!.dwarfs[0]!),
        badge: needsYouCount(mines)
      })
      heard.push(allCues())
      stopCues?.()
      stopAudio?.()
      harness.audio.dispose()
      useMines().clear()
    }
    expect(shown[1]).toEqual(shown[0])
    expect(heard).toEqual([1, 0])
  })

  it('[US-SET-005.AC04, US-SHELL-010.AC05] toggling notification sounds changes neither the Music, Ambience and Effects volumes nor System notifications', async () => {
    await mount({ musicVolume: 0.4, ambienceVolume: 0.3, voiceVolume: 0.2 })
    const before = { ...harness.audio.settings.value }
    board(defaultDwarf({ id: 'd1', status: 'working' }))

    await harness.audio.setSettings({ notificationSounds: false })
    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }))
    expect(allCues()).toBe(0)

    await harness.audio.setSettings({ notificationSounds: true })
    board(defaultDwarf({ id: 'd1', status: 'waiting', pendingPermission: permission('ask-2') }))
    expect(cues('permission')).toHaveLength(1)

    expect(harness.audioWrites.map((written) => written.notificationSounds)).toEqual([false, true])
    for (const written of harness.audioWrites) {
      expect({
        music: written.musicVolume,
        ambience: written.ambienceVolume,
        effects: written.voiceVolume
      }).toEqual({
        music: before.musicVolume,
        ambience: before.ambienceVolume,
        effects: before.voiceVolume
      })
    }
    expect(harness.systemNotificationWrites).toEqual([])
  })

  it('[INV-103] an ask with reannounce false plays nothing', async () => {
    await mount()
    const cuesOf = useAttentionCues()
    cuesOf.askOpened({ dwarfId: 'd1', kind: 'question', askId: 'ask-r', reannounce: false })
    expect(allCues()).toBe(0)
    cuesOf.askOpened({ dwarfId: 'd1', kind: 'question', askId: 'ask-n', reannounce: true })
    expect(cues('question')).toHaveLength(1)
  })

  it('[NFR-SND-05] an attention cue plays once with loop off, and a new interface cue stops the previous interface cue before it plays', async () => {
    await mount()
    board(
      defaultDwarf({ id: 'd1', status: 'working' }),
      defaultDwarf({ id: 'd2', status: 'working' })
    )

    board(
      defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }),
      defaultDwarf({ id: 'd2', status: 'working' })
    )
    expect(cues('question')).toHaveLength(1)
    const first = cues('question')[0]!
    expect(first.loop).toBe(false)
    expect(first.playing).toBe(true)

    board(
      defaultDwarf({ id: 'd1', status: 'waiting', pendingQuestion: question('ask-1') }),
      defaultDwarf({ id: 'd2', status: 'waiting', pendingQuestion: question('ask-2') })
    )
    const second = cues('question')[1]!
    expect(first.stopped).toBe(true)
    expect(second.loop).toBe(false)
    expect(second.playing).toBe(true)
    // Once: reaching its end releases it, and nothing reopens it.
    second.end()
    expect(second.stopped).toBe(true)
    expect(cues('question')).toHaveLength(2)
  })

  it('[US-SHELL-010.AC02, NFR-SND-08] a reliable turn.ended plays the finished cue once per turnKey, an inferred or app-cancelled end plays nothing', async () => {
    await mount()
    const reliable = { reliability: 'reliable', cancelledFromApp: false } as const
    harness.push([
      turnEnded(1, {
        dwarfId: BORIN,
        turnKey: 't-inferred',
        kind: 'concluded',
        reliability: 'inferred',
        cancelledFromApp: false
      }),
      turnEnded(2, {
        dwarfId: BORIN,
        turnKey: 't-cancelled',
        kind: 'interrupted',
        reliability: 'reliable',
        cancelledFromApp: true
      })
    ])
    expect(cues('finished')).toHaveLength(0)

    harness.push([turnEnded(3, { dwarfId: BORIN, turnKey: 't-1', kind: 'concluded', ...reliable })])
    expect(cues('finished')).toHaveLength(1)
    // A replayed frame (a resync) is the same turn.
    harness.push([turnEnded(3, { dwarfId: BORIN, turnKey: 't-1', kind: 'concluded', ...reliable })])
    expect(cues('finished')).toHaveLength(1)
    // In every mode, Veta included: the Panel closed to its rail still hears the next end.
    harness.audio.setCollapsed(true)
    harness.push([turnEnded(4, { dwarfId: BORIN, turnKey: 't-2', kind: 'errored', ...reliable })])
    expect(cues('finished')).toHaveLength(2)
  })

  it("[US-SET-005.AC01, NFR-SND-08] a turn end on today's board plays the finished cue once, and never for a turn cancelled from the app", async () => {
    await mount()
    board(defaultDwarf({ id: 'd1', status: 'working', lastTurn: turn(100) }))
    expect(cues('finished')).toHaveLength(0)

    board(defaultDwarf({ id: 'd1', status: 'waiting', lastTurn: turn(200) }))
    board(defaultDwarf({ id: 'd1', status: 'waiting', lastTurn: turn(200) }))
    expect(cues('finished')).toHaveLength(1)

    board(
      defaultDwarf({ id: 'd1', status: 'waiting', lastTurn: turn(300, { cancelledFromApp: true }) })
    )
    expect(cues('finished')).toHaveLength(1)
  })
})
