// layer: L2
import { describe, expect, it } from 'vitest'
import {
  createInMemoryUiPreferenceStorage,
  InMemoryUiPreferenceStore,
  type InMemoryUiPreferenceStorage
} from '../ports/fakes/InMemoryUiPreferenceStore'
import type { TypographyPreferences } from '../ports/uiPreferenceStore'
import { createUiPreferences, type ModeWindowSender } from './uiPreferences'

/** A mode window that records every push it is sent. */
class RecordingModeWindow implements ModeWindowSender {
  readonly pushes: Array<[string, unknown]> = []
  send(push: string, payload: unknown): void {
    this.pushes.push([push, payload])
  }
}

/** One app start over `storage` (the double's userData folder), with these mode windows open. */
function start(
  storage: InMemoryUiPreferenceStorage,
  windows: readonly ModeWindowSender[] = []
): ReturnType<typeof createUiPreferences> {
  return createUiPreferences({
    store: new InMemoryUiPreferenceStore(storage),
    modeWindows: () => windows
  })
}

const CUSTOM: TypographyPreferences = {
  style: 'custom',
  faces: { display: 'tiny5', label: 'roboto', meta: 'arial', talk: 'roboto' }
}

describe('UI preference stores (ADR-024 items 1, 9)', () => {
  it('[US-SHELL-006.AC01, S10.01, NFR-PERS-10] the launch view saved at close is returned before the first paint at the next start', () => {
    const storage = createInMemoryUiPreferenceStorage()
    start(storage).set('launchView', { area: 'market', mineId: 'mine-3' })

    // The next start answers at once, synchronously: nothing to await before mount.
    const answer: unknown = start(storage).get('launchView')
    expect(answer).not.toBeInstanceOf(Promise)
    expect(answer).toEqual({ area: 'market', mineId: 'mine-3' })
  })

  it('[US-SHELL-006.AC02] with no stored launch view the answer is the Map page with no mine', () => {
    expect(start(createInMemoryUiPreferenceStorage()).get('launchView')).toEqual({
      area: 'map',
      mineId: null
    })
  })

  it('[US-SHELL-006.AC03] a stored mine id is returned as stored and the page is kept', () => {
    const storage = createInMemoryUiPreferenceStorage()
    // UI main does not know the board: dropping a mine that is gone is the renderer's `restoreLaunchView`.
    start(storage).set('launchView', { area: 'settings', mineId: 'mine-removed-since' })
    expect(start(storage).get('launchView')).toEqual({
      area: 'settings',
      mineId: 'mine-removed-since'
    })
  })

  it('[US-SHELL-006.AC02] an empty mine id is stored as no mine', () => {
    const preferences = start(createInMemoryUiPreferenceStorage())
    expect(preferences.set('launchView', { area: 'lab', mineId: '' })).toEqual({
      area: 'lab',
      mineId: null
    })
  })

  it('[US-SET-003.AC02] picking a preset stores it and clears any per-role Custom faces', () => {
    const storage = createInMemoryUiPreferenceStorage()
    const preferences = start(storage)
    preferences.set('typography', CUSTOM)

    const pixelClean = {
      style: 'pixel-clean',
      faces: {
        display: 'pixelify-sans',
        label: 'pixelify-sans',
        meta: 'pixelify-sans',
        talk: 'pixelify-sans'
      }
    }
    expect(preferences.set('typography', { style: 'pixel-clean', faces: CUSTOM.faces })).toEqual(
      pixelClean
    )
    expect(start(storage).get('typography')).toEqual(pixelClean)
  })

  it('[US-SET-003.AC04] changing one Custom role stores only that role and broadcasts onTypographyPreferences to every mode window', () => {
    const storage = createInMemoryUiPreferenceStorage()
    const panel = new RecordingModeWindow()
    const veta = new RecordingModeWindow()
    start(storage).set('typography', CUSTOM)

    const changed = { style: 'custom', faces: { ...CUSTOM.faces, talk: 'arial' } } as const
    const stored = start(storage, [panel, veta]).set('typography', changed)

    expect(stored).toEqual(changed)
    expect(start(storage).get('typography')).toEqual(changed)
    for (const window of [panel, veta]) {
      expect(window.pushes).toEqual([['typography:preferences:changed', changed]])
    }
  })

  it('[US-SET-003.AC04] a Custom face its role does not offer is stored as that role’s DwarfAI face', () => {
    const preferences = start(createInMemoryUiPreferenceStorage())
    expect(
      preferences.set('typography', {
        style: 'custom',
        faces: { display: 'roboto', label: 'jacquard-12', meta: 'tiny5', talk: 'tiny5' }
      })
    ).toEqual({
      style: 'custom',
      faces: { display: 'roboto', label: 'tiny5', meta: 'pixelify-sans', talk: 'pixelify-sans' }
    })
  })

  it('[US-SET-003.AC07] an older two-choice typography file loads as DwarfAI, Pixel clean, Readable or the mapped Custom set', () => {
    const cases: Array<[unknown, TypographyPreferences]> = [
      [
        { interfaceFont: 'tiny5', messagingFont: 'pixelify-sans' },
        {
          style: 'dwarfai',
          faces: {
            display: 'jacquard-12',
            label: 'tiny5',
            meta: 'pixelify-sans',
            talk: 'pixelify-sans'
          }
        }
      ],
      [
        { interfaceFont: 'pixelify-sans', messagingFont: 'pixelify-sans' },
        {
          style: 'pixel-clean',
          faces: {
            display: 'pixelify-sans',
            label: 'pixelify-sans',
            meta: 'pixelify-sans',
            talk: 'pixelify-sans'
          }
        }
      ],
      [
        { interfaceFont: 'roboto', messagingFont: 'roboto' },
        {
          style: 'readable',
          faces: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' }
        }
      ],
      // Any other pair: Titles Jacquard 12, Labels and Small text the old Interface face, Messages the old one.
      [
        { interfaceFont: 'arial', messagingFont: 'roboto' },
        {
          style: 'custom',
          faces: { display: 'jacquard-12', label: 'arial', meta: 'arial', talk: 'roboto' }
        }
      ],
      // Small text does not offer Tiny5: it becomes Pixelify Sans.
      [
        { interfaceFont: 'tiny5', messagingFont: 'arial' },
        {
          style: 'custom',
          faces: { display: 'jacquard-12', label: 'tiny5', meta: 'pixelify-sans', talk: 'arial' }
        }
      ],
      // A face the older build could not draw read as its default there (Tiny5, Pixelify Sans): what the person saw.
      [
        { interfaceFont: 'comic-sans', messagingFont: 'tiny5' },
        {
          style: 'dwarfai',
          faces: {
            display: 'jacquard-12',
            label: 'tiny5',
            meta: 'pixelify-sans',
            talk: 'pixelify-sans'
          }
        }
      ]
    ]
    for (const [older, expected] of cases) {
      const storage = createInMemoryUiPreferenceStorage()
      storage.twoChoiceTypography = older
      expect(start(storage).get('typography')).toEqual(expected)
    }
  })

  it('[US-SET-004.AC02] music at startup off is stored and read back at the next start', () => {
    const storage = createInMemoryUiPreferenceStorage()
    const audio = start(storage).get('audio')
    start(storage).set('audio', { ...audio, musicAtStartup: false })
    expect(start(storage).get('audio').musicAtStartup).toBe(false)

    start(storage).set('audio', { ...audio, musicAtStartup: true })
    expect(start(storage).get('audio').musicAtStartup).toBe(true)
  })

  it('[US-SET-004.AC03] a volume change answers the stored value at once', () => {
    const storage = createInMemoryUiPreferenceStorage()
    const preferences = start(storage)
    const audio = preferences.get('audio')

    expect(preferences.set('audio', { ...audio, ambienceVolume: 0.42 })).toEqual({
      ...audio,
      ambienceVolume: 0.42
    })
    // A slider cannot mean more than all of it, or less than none: the stored value is clamped to 0..1.
    expect(preferences.set('audio', { ...audio, musicVolume: 1.5, voiceVolume: -0.2 })).toEqual({
      ...audio,
      musicVolume: 1,
      voiceVolume: 0
    })
    expect(start(storage).get('audio')).toEqual({ ...audio, musicVolume: 1, voiceVolume: 0 })
  })

  it('[ADR-024] a setter whose write failed answers the value still stored, and nothing is broadcast', () => {
    const storage = createInMemoryUiPreferenceStorage()
    const panel = new RecordingModeWindow()
    const preferences = start(storage, [panel])
    preferences.set('typography', CUSTOM)
    panel.pushes.length = 0

    storage.interruptNextSave = true
    expect(preferences.set('typography', { ...CUSTOM, style: 'readable' })).toEqual(CUSTOM)
    expect(panel.pushes).toEqual([])
  })
})
