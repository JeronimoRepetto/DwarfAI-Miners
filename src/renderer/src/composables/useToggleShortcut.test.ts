// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../../shared/accelerator'
import type { ShortcutState } from '../types'
import { useToggleShortcut } from './useToggleShortcut'

function state(overrides: Partial<ShortcutState> = {}): ShortcutState {
  return {
    accelerator: DEFAULT_TOGGLE_ACCELERATOR,
    registered: true,
    platform: 'win32',
    ...overrides
  }
}

function stubApi(api: {
  getToggleShortcut?: () => Promise<ShortcutState>
  setToggleShortcut?: (accelerator: string) => Promise<ShortcutState>
}): void {
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

/** A keydown as the recorder receives it, so preventDefault can be observed. */
function keydown(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', init)
  vi.spyOn(event, 'preventDefault')
  return event
}

/** Resolves only when `release()` is called, so an in-flight change can be observed. */
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('useToggleShortcut — reading the real state', () => {
  it('knows nothing until main answers, rather than guessing a default', () => {
    // Unlike the pin toggle there is no safe first guess: the stored
    // accelerator is unknown AND it may not even be registered.
    stubApi({})
    expect(useToggleShortcut().state.value).toBeNull()
  })

  it('adopts the state main reports', async () => {
    const real = state({ accelerator: 'Control+Alt+M' })
    stubApi({ getToggleShortcut: () => Promise.resolve(real) })
    const shortcut = useToggleShortcut()
    await shortcut.sync()
    expect(shortcut.state.value).toEqual(real)
  })

  it('surfaces a startup registration failure as the error the panel shows', async () => {
    // The whole point of #17: the user must learn the combination is dead.
    const dead = state({ registered: false, error: 'Ctrl + Alt + Shift + P is already in use.' })
    stubApi({ getToggleShortcut: () => Promise.resolve(dead) })
    const shortcut = useToggleShortcut()
    await shortcut.sync()
    expect(shortcut.state.value?.registered).toBe(false)
    expect(shortcut.error.value).toBe('Ctrl + Alt + Shift + P is already in use.')
  })

  it('keeps the last known state when the bridge is unreachable', async () => {
    const real = state({ accelerator: 'Control+Alt+M' })
    let answer: () => Promise<ShortcutState> = () => Promise.resolve(real)
    stubApi({ getToggleShortcut: () => answer() })
    const shortcut = useToggleShortcut()
    await shortcut.sync()
    answer = () => Promise.reject(new Error('bridge is gone'))
    await shortcut.sync()
    expect(shortcut.state.value).toEqual(real)
  })
})

describe('useToggleShortcut — recording a combination', () => {
  it('announces it is listening, and stops when told', () => {
    stubApi({})
    const shortcut = useToggleShortcut()
    expect(shortcut.recording.value).toBe(false)
    shortcut.startRecording()
    expect(shortcut.recording.value).toBe(true)
    shortcut.stopRecording()
    expect(shortcut.recording.value).toBe(false)
  })

  it('swallows the keystroke while listening, so Tab and Space do not act', async () => {
    stubApi({ setToggleShortcut: () => Promise.resolve(state()) })
    const shortcut = useToggleShortcut()
    shortcut.startRecording()
    const event = keydown({ code: 'Tab', key: 'Tab', ctrlKey: true })
    await shortcut.record(event)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('ignores keystrokes entirely when it is not listening', async () => {
    const setToggleShortcut = vi.fn()
    stubApi({ setToggleShortcut })
    const shortcut = useToggleShortcut()
    const event = keydown({ code: 'KeyM', key: 'm', ctrlKey: true, altKey: true })
    await shortcut.record(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(setToggleShortcut).not.toHaveBeenCalled()
  })

  it('keeps waiting silently while only modifiers are held', async () => {
    // The user is mid-chord; complaining here would flash an error on the way
    // to every perfectly good shortcut.
    const setToggleShortcut = vi.fn()
    stubApi({ setToggleShortcut })
    const shortcut = useToggleShortcut()
    shortcut.startRecording()
    await shortcut.record(keydown({ code: 'ControlLeft', key: 'Control', ctrlKey: true }))
    expect(shortcut.recording.value).toBe(true)
    expect(shortcut.error.value).toBeNull()
    expect(setToggleShortcut).not.toHaveBeenCalled()
  })

  it('cancels on Escape without changing anything', async () => {
    const setToggleShortcut = vi.fn()
    stubApi({ setToggleShortcut })
    const shortcut = useToggleShortcut()
    shortcut.startRecording()
    const event = keydown({ code: 'Escape', key: 'Escape' })
    await shortcut.record(event)
    expect(shortcut.recording.value).toBe(false)
    expect(setToggleShortcut).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('sends the translated accelerator and adopts the verdict', async () => {
    const setToggleShortcut = vi.fn().mockResolvedValue(state({ accelerator: 'Control+Alt+M' }))
    stubApi({ setToggleShortcut })
    const shortcut = useToggleShortcut()
    shortcut.startRecording()
    await shortcut.record(keydown({ code: 'KeyM', key: 'm', ctrlKey: true, altKey: true }))
    expect(setToggleShortcut).toHaveBeenCalledWith('Control+Alt+M')
    expect(shortcut.state.value?.accelerator).toBe('Control+Alt+M')
    expect(shortcut.recording.value).toBe(false)
  })

  it('renders the kept combination, not the one that was asked for', async () => {
    // Main refused and reverted: showing 'Control+Alt+M' here would tell the
    // user a shortcut works when nothing is bound to it.
    const reverted = state({
      accelerator: DEFAULT_TOGGLE_ACCELERATOR,
      error: 'Ctrl + Alt + M is already in use by another application.'
    })
    stubApi({ setToggleShortcut: () => Promise.resolve(reverted) })
    const shortcut = useToggleShortcut()
    shortcut.startRecording()
    await shortcut.record(keydown({ code: 'KeyM', key: 'm', ctrlKey: true, altKey: true }))
    expect(shortcut.state.value?.accelerator).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(shortcut.error.value).toBe('Ctrl + Alt + M is already in use by another application.')
  })

  it('refuses an unusable chord locally and stays listening for a better one', async () => {
    const setToggleShortcut = vi.fn()
    stubApi({ setToggleShortcut })
    const shortcut = useToggleShortcut()
    shortcut.startRecording()
    await shortcut.record(keydown({ code: 'KeyP', key: 'p' }))
    expect(setToggleShortcut).not.toHaveBeenCalled()
    expect(shortcut.error.value).toMatch(/modifier/i)
    // Still listening: the user can simply press a better combination.
    expect(shortcut.recording.value).toBe(true)
  })

  it('clears a stale error when recording starts again', async () => {
    stubApi({ setToggleShortcut: vi.fn() })
    const shortcut = useToggleShortcut()
    shortcut.startRecording()
    await shortcut.record(keydown({ code: 'KeyP', key: 'p' }))
    expect(shortcut.error.value).toBeTruthy()
    shortcut.startRecording()
    expect(shortcut.error.value).toBeNull()
  })

  it('prefers the fresh local refusal over the error main reported earlier', async () => {
    stubApi({
      getToggleShortcut: () =>
        Promise.resolve(state({ registered: false, error: 'startup failed' })),
      setToggleShortcut: vi.fn()
    })
    const shortcut = useToggleShortcut()
    await shortcut.sync()
    shortcut.startRecording()
    await shortcut.record(keydown({ code: 'KeyP', key: 'p' }))
    expect(shortcut.error.value).not.toBe('startup failed')
  })
})

describe('useToggleShortcut — applying and resetting', () => {
  it('resets to the documented default', async () => {
    const setToggleShortcut = vi.fn().mockResolvedValue(state())
    stubApi({ setToggleShortcut })
    await useToggleShortcut().reset()
    expect(setToggleShortcut).toHaveBeenCalledWith(DEFAULT_TOGGLE_ACCELERATOR)
  })

  it('re-reads the real state when the change never reached main', async () => {
    // The call broke somewhere in between: it may or may not have applied, so
    // asking beats assuming either outcome.
    const real = state({ accelerator: 'Control+Alt+M' })
    stubApi({
      setToggleShortcut: () => Promise.reject(new Error('handler crashed')),
      getToggleShortcut: () => Promise.resolve(real)
    })
    const shortcut = useToggleShortcut()
    await shortcut.reset()
    expect(shortcut.state.value).toEqual(real)
    expect(shortcut.error.value).toBeTruthy()
  })

  it('ignores a second change while the first is still in flight', async () => {
    const pending = deferred<ShortcutState>()
    const setToggleShortcut = vi.fn().mockReturnValue(pending.promise)
    stubApi({ setToggleShortcut })
    const shortcut = useToggleShortcut()

    const first = shortcut.reset()
    await shortcut.reset()
    expect(setToggleShortcut).toHaveBeenCalledTimes(1)

    pending.release(state())
    await first
    expect(shortcut.applying.value).toBe(false)
  })

  it('reports while a change is in flight so the panel can say so', async () => {
    const pending = deferred<ShortcutState>()
    stubApi({ setToggleShortcut: () => pending.promise })
    const shortcut = useToggleShortcut()
    const first = shortcut.reset()
    expect(shortcut.applying.value).toBe(true)
    pending.release(state())
    await first
  })
})
