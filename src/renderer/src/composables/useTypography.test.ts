// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TYPOGRAPHY_PREFERENCES, type TypographyPreferences } from '../types'
import { useTypography } from './useTypography'

/**
 * Settings' Typography section, renderer side (#370).
 *
 * Two rules it exists to enforce, and both have a scar behind them elsewhere in
 * this codebase. The first is the honesty rule `usePinnedWindow` holds for the
 * pin: the faces only ever become what MAIN answered with, because a choice
 * main refused — Tiny5 for messaging above all — must never be drawn as the one
 * in force. The second is that applying a face is ONE write to the document
 * root: every component already reads `--font-pixel` or `--font-conversation`,
 * so nothing below this file needs to know a preference exists.
 */
function fakeApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getTypographyPreferences: vi.fn().mockResolvedValue({ ...DEFAULT_TYPOGRAPHY_PREFERENCES }),
    setTypographyPreferences: vi.fn(async (preferences: TypographyPreferences) => preferences),
    onTypographyPreferences: vi.fn(() => () => undefined),
    ...overrides
  }
  ;(globalThis as { window?: unknown }).window = Object.assign(globalThis.window ?? {}, { api })
  return api
}

/*
 * AMENDED for the type presets (#635): a choice is now a font style and four role faces, painted
 * through `--f-display`, `--f-label`, `--f-meta` and `--f-talk` with the sizes they are sharp at,
 * and `set` takes the whole document Settings built (lib/settings/fontStyle.ts builds it). Each
 * test below keeps its #370 guarantee and says what it was.
 */
const ROLE_PROPERTIES = ['--f-display', '--f-label', '--f-meta', '--f-talk'] as const
const SIZE_PROPERTIES = ['--fs-title', '--fs-headline', '--fs-section', '--fs-meta', '--fs-body']

function paintedFonts(): Record<string, string> {
  const root = document.documentElement
  return Object.fromEntries(
    ROLE_PROPERTIES.map((property) => [property, root.style.getPropertyValue(property)])
  )
}

const READABLE: TypographyPreferences = {
  style: 'readable',
  faces: { display: 'roboto', label: 'roboto', meta: 'roboto', talk: 'roboto' }
}
const CUSTOM: TypographyPreferences = {
  style: 'custom',
  faces: { display: 'tiny5', label: 'roboto', meta: 'arial', talk: 'pixelify-sans' }
}

afterEach(() => {
  for (const property of [...ROLE_PROPERTIES, ...SIZE_PROPERTIES]) {
    document.documentElement.style.removeProperty(property)
  }
})

describe('useTypography', () => {
  it('starts on the documented defaults, so the first paint matches the stylesheet', () => {
    fakeApi()
    expect(useTypography().preferences.value).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
  })

  it('paints nothing until it has been told something, leaving the stylesheet in charge', () => {
    fakeApi()
    useTypography()
    expect(Object.values(paintedFonts())).toEqual(['', '', '', ''])
  })

  // AMENDED (#635): was "…repoints both roles on the document root".
  it('adopts the stored faces on sync and repoints every role on the document root', async () => {
    fakeApi({ getTypographyPreferences: vi.fn().mockResolvedValue(CUSTOM) })
    const { preferences, sync } = useTypography()
    await sync()
    expect(preferences.value).toEqual(CUSTOM)
    expect(paintedFonts()).toEqual({
      '--f-display': 'var(--font-family-tiny5)',
      '--f-label': 'var(--font-family-roboto)',
      '--f-meta': 'var(--font-family-arial)',
      '--f-talk': 'var(--font-family-pixelify-sans)'
    })
    // Crisp sizes on: Tiny5 titles snap from 21px to 24px, where each of its pixels is whole.
    expect(document.documentElement.style.getPropertyValue('--fs-title')).toBe('24px')
  })

  it('keeps the last known faces when the bridge is unreachable', async () => {
    fakeApi({ getTypographyPreferences: vi.fn().mockRejectedValue(new Error('no bridge')) })
    const { preferences, sync } = useTypography()
    await sync()
    expect(preferences.value).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
  })

  // AMENDED (#635): was "changes one role and leaves the other exactly where it was", when set
  // merged a one-role patch here. Settings now builds the whole document, and this sends exactly
  // that, so a role nobody touched arrives as it was.
  it('sends the whole document it was handed and adopts the answer', async () => {
    const api = fakeApi()
    const { preferences, set } = useTypography()
    await set(CUSTOM)
    expect(api.setTypographyPreferences).toHaveBeenCalledWith(CUSTOM)
    expect(preferences.value).toEqual(CUSTOM)
  })

  // AMENDED (#635): was "lets both roles name one family, which is how the whole app becomes that
  // face"; a preset that names one family in every role is how that happens now.
  it('lets every role name one family, which is how the whole app becomes that face', async () => {
    fakeApi()
    const { preferences, set } = useTypography()
    await set(READABLE)
    expect(preferences.value).toEqual(READABLE)
    expect(Object.values(paintedFonts())).toEqual(
      ROLE_PROPERTIES.map(() => 'var(--font-family-roboto)')
    )
  })

  // AMENDED (#635): the same rule, on a Tiny5 message face main refuses.
  it('renders what main STORED, never what the press asked for', async () => {
    // Main refuses Tiny5 for messages at its boundary, so what comes back is the face really in
    // force and that is what has to be drawn.
    const stored: TypographyPreferences = {
      style: 'custom',
      faces: { ...CUSTOM.faces, talk: 'pixelify-sans' }
    }
    const api = fakeApi({ setTypographyPreferences: vi.fn().mockResolvedValue(stored) })
    const { preferences, set } = useTypography()
    await set({ style: 'custom', faces: { ...CUSTOM.faces, talk: 'tiny5' as never } })
    expect(api.setTypographyPreferences).toHaveBeenCalled()
    expect(preferences.value.faces.talk).toBe('pixelify-sans')
    expect(paintedFonts()['--f-talk']).toBe('var(--font-family-pixelify-sans)')
  })

  it('re-reads the real faces when a change breaks mid-flight', async () => {
    const api = fakeApi({
      setTypographyPreferences: vi.fn().mockRejectedValue(new Error('no bridge')),
      getTypographyPreferences: vi.fn().mockResolvedValue(READABLE)
    })
    const { preferences, set } = useTypography()
    await set(CUSTOM)
    expect(api.getTypographyPreferences).toHaveBeenCalled()
    expect(preferences.value).toEqual(READABLE)
  })

  it('ignores a second press while one is still in flight', async () => {
    let release: (value: TypographyPreferences) => void = () => undefined
    const api = fakeApi({
      setTypographyPreferences: vi.fn(
        () =>
          new Promise<TypographyPreferences>((resolve) => {
            release = resolve
          })
      )
    })
    const { set } = useTypography()
    const first = set(READABLE)
    await set(CUSTOM)
    expect(api.setTypographyPreferences).toHaveBeenCalledTimes(1)
    release(READABLE)
    await first
  })

  it('adopts a change this window did not make, which is how the other one keeps up', async () => {
    // The shell owns Settings; the message panel is a second window drawing the message face.
    // Without this push it would stay on the old one until a reload.
    let push: ((preferences: TypographyPreferences) => void) | undefined
    fakeApi({
      onTypographyPreferences: vi.fn((listener: (p: TypographyPreferences) => void) => {
        push = listener
        return () => undefined
      })
    })
    const { preferences, listen } = useTypography()
    listen()
    push?.(READABLE)
    expect(preferences.value).toEqual(READABLE)
    expect(paintedFonts()['--f-talk']).toBe('var(--font-family-roboto)')
  })

  it('hands back an unsubscribe, so a window can stop listening with its own teardown', () => {
    const stop = vi.fn()
    fakeApi({ onTypographyPreferences: vi.fn(() => stop) })
    const unlisten = useTypography().listen()
    unlisten()
    expect(stop).toHaveBeenCalled()
  })

  // APPENDED (#635): what reaches the page is read through the shared parser once more, so a
  // document this build cannot draw (an older window's, a stale bridge's) paints the defaults
  // rather than throwing out of the window's setup.
  it('paints a document it cannot read as the defaults, never throwing', async () => {
    fakeApi({
      getTypographyPreferences: vi
        .fn()
        .mockResolvedValue({ interfaceFont: 'roboto', messagingFont: 'arial' })
    })
    const { preferences, sync } = useTypography()
    await sync()
    expect(preferences.value).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
    expect(paintedFonts()['--f-display']).toBe('var(--font-family-jacquard-12)')
  })
})
