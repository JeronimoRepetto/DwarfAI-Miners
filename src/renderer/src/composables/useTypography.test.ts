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

function paintedFonts(): { interfaceFont: string; messagingFont: string } {
  const root = document.documentElement
  return {
    interfaceFont: root.style.getPropertyValue('--font-pixel'),
    messagingFont: root.style.getPropertyValue('--font-conversation')
  }
}

afterEach(() => {
  document.documentElement.style.removeProperty('--font-pixel')
  document.documentElement.style.removeProperty('--font-conversation')
})

describe('useTypography', () => {
  it('starts on the documented defaults, so the first paint matches the stylesheet', () => {
    fakeApi()
    expect(useTypography().preferences.value).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
  })

  it('paints nothing until it has been told something, leaving the stylesheet in charge', () => {
    fakeApi()
    useTypography()
    expect(paintedFonts()).toEqual({ interfaceFont: '', messagingFont: '' })
  })

  it('adopts the stored faces on sync and repoints both roles on the document root', async () => {
    fakeApi({
      getTypographyPreferences: vi
        .fn()
        .mockResolvedValue({ interfaceFont: 'roboto', messagingFont: 'arial' })
    })
    const { preferences, sync } = useTypography()
    await sync()
    expect(preferences.value).toEqual({ interfaceFont: 'roboto', messagingFont: 'arial' })
    expect(paintedFonts()).toEqual({
      interfaceFont: 'var(--font-family-roboto)',
      messagingFont: 'var(--font-family-arial)'
    })
  })

  it('keeps the last known faces when the bridge is unreachable', async () => {
    fakeApi({ getTypographyPreferences: vi.fn().mockRejectedValue(new Error('no bridge')) })
    const { preferences, sync } = useTypography()
    await sync()
    expect(preferences.value).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
  })

  it('changes one role and leaves the other exactly where it was', async () => {
    // The whole point of the feature: keep the pixel chrome, read the messages
    // in something else — or the reverse.
    const api = fakeApi()
    const { preferences, set } = useTypography()
    await set({ messagingFont: 'roboto' })
    expect(api.setTypographyPreferences).toHaveBeenCalledWith({
      interfaceFont: 'tiny5',
      messagingFont: 'roboto'
    })
    expect(preferences.value).toEqual({ interfaceFont: 'tiny5', messagingFont: 'roboto' })
  })

  it('lets both roles name one family, which is how the whole app becomes that face', async () => {
    fakeApi()
    const { preferences, set } = useTypography()
    await set({ interfaceFont: 'arial' })
    await set({ messagingFont: 'arial' })
    expect(preferences.value).toEqual({ interfaceFont: 'arial', messagingFont: 'arial' })
    expect(paintedFonts()).toEqual({
      interfaceFont: 'var(--font-family-arial)',
      messagingFont: 'var(--font-family-arial)'
    })
  })

  it('renders what main STORED, never what the press asked for', async () => {
    // Main refuses Tiny5 for messaging at its boundary, so what comes back is
    // the face really in force and that is what has to be drawn.
    const api = fakeApi({
      setTypographyPreferences: vi
        .fn()
        .mockResolvedValue({ interfaceFont: 'tiny5', messagingFont: 'pixelify-sans' })
    })
    const { preferences, set } = useTypography()
    await set({ messagingFont: 'tiny5' as never })
    expect(api.setTypographyPreferences).toHaveBeenCalled()
    expect(preferences.value.messagingFont).toBe('pixelify-sans')
    expect(paintedFonts().messagingFont).toBe('var(--font-family-pixelify-sans)')
  })

  it('re-reads the real faces when a change breaks mid-flight', async () => {
    const api = fakeApi({
      setTypographyPreferences: vi.fn().mockRejectedValue(new Error('no bridge')),
      getTypographyPreferences: vi
        .fn()
        .mockResolvedValue({ interfaceFont: 'roboto', messagingFont: 'roboto' })
    })
    const { preferences, set } = useTypography()
    await set({ interfaceFont: 'arial' })
    expect(api.getTypographyPreferences).toHaveBeenCalled()
    expect(preferences.value).toEqual({ interfaceFont: 'roboto', messagingFont: 'roboto' })
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
    const first = set({ interfaceFont: 'roboto' })
    await set({ interfaceFont: 'arial' })
    expect(api.setTypographyPreferences).toHaveBeenCalledTimes(1)
    release({ interfaceFont: 'roboto', messagingFont: 'pixelify-sans' })
    await first
  })

  it('adopts a change this window did not make, which is how the other one keeps up', async () => {
    // The shell owns Settings; the message panel is a second window drawing the
    // messaging face. Without this push it would stay on the old one until a
    // reload.
    let push: ((preferences: TypographyPreferences) => void) | undefined
    fakeApi({
      onTypographyPreferences: vi.fn((listener: (p: TypographyPreferences) => void) => {
        push = listener
        return () => undefined
      })
    })
    const { preferences, listen } = useTypography()
    listen()
    push?.({ interfaceFont: 'arial', messagingFont: 'roboto' })
    expect(preferences.value).toEqual({ interfaceFont: 'arial', messagingFont: 'roboto' })
    expect(paintedFonts()).toEqual({
      interfaceFont: 'var(--font-family-arial)',
      messagingFont: 'var(--font-family-roboto)'
    })
  })

  it('hands back an unsubscribe, so a window can stop listening with its own teardown', () => {
    const stop = vi.fn()
    fakeApi({ onTypographyPreferences: vi.fn(() => stop) })
    const unlisten = useTypography().listen()
    unlisten()
    expect(stop).toHaveBeenCalled()
  })
})
