import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOGGLE_ACCELERATOR } from '../../shared/accelerator'
import { createShortcutPreferenceStore, type ShortcutPreferenceFsLike } from './shortcutPreference'
import { createToggleShortcut, type GlobalShortcutLike } from './shortcuts'

/**
 * Deterministic stand-in for Electron's `globalShortcut`. It models the two
 * ways the real one says no — returning false when another application already
 * owns the combination, and THROWING on a string its parser dislikes — plus an
 * event log, because the ordering (release the old one before claiming the new
 * one) is part of the contract.
 */
function fakeGlobalShortcut(options: { taken?: string[]; throwsOn?: string[] } = {}) {
  const held = new Map<string, () => void>()
  const events: string[] = []
  const taken = new Set(options.taken ?? [])
  const throwsOn = new Set(options.throwsOn ?? [])
  const api: GlobalShortcutLike = {
    register: (accelerator, callback) => {
      events.push(`register:${accelerator}`)
      if (throwsOn.has(accelerator)) throw new Error('Invalid accelerator')
      if (taken.has(accelerator)) return false
      held.set(accelerator, callback)
      return true
    },
    unregister: (accelerator) => {
      events.push(`unregister:${accelerator}`)
      held.delete(accelerator)
    },
    unregisterAll: () => {
      events.push('unregisterAll')
      held.clear()
    }
  }
  return { api, held, events, taken }
}

function controller(
  options: {
    initial?: string
    taken?: string[]
    throwsOn?: string[]
    onToggle?: () => void
    platform?: 'darwin' | 'win32' | 'other'
  } = {}
) {
  const shortcut = fakeGlobalShortcut({ taken: options.taken, throwsOn: options.throwsOn })
  const toggle = createToggleShortcut({
    initial: options.initial ?? DEFAULT_TOGGLE_ACCELERATOR,
    onToggle: options.onToggle ?? (() => undefined),
    globalShortcut: shortcut.api,
    platform: options.platform ?? 'win32'
  })
  return { toggle, ...shortcut }
}

describe('createToggleShortcut — startup', () => {
  it('claims the loaded accelerator and reports it as really registered', () => {
    const { toggle, held } = controller({ initial: 'Control+Alt+M' })
    const state = toggle.start()
    expect(state.accelerator).toBe('Control+Alt+M')
    expect(state.registered).toBe(true)
    expect(state.error).toBeUndefined()
    expect(held.has('Control+Alt+M')).toBe(true)
  })

  it('binds the toggle callback itself, not a wrapper that drops the call', () => {
    const onToggle = vi.fn()
    const { toggle, held } = controller({ initial: 'Control+Alt+M', onToggle })
    toggle.start()
    held.get('Control+Alt+M')?.()
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('reports a startup registration failure as state the settings UI can render', () => {
    // This is the whole point of #17: the old code only console.warn'd here, so
    // the user never learned their shortcut was dead.
    const { toggle } = controller({ initial: 'Control+Alt+M', taken: ['Control+Alt+M'] })
    const state = toggle.start()
    // The accelerator is still reported, so the panel can say WHICH combination
    // is unavailable rather than showing a blank.
    expect(state.accelerator).toBe('Control+Alt+M')
    expect(state.registered).toBe(false)
    expect(state.error).toBeTruthy()
  })

  it('treats a throwing register exactly like a refusal', () => {
    const { toggle } = controller({ initial: 'Control+Alt+M', throwsOn: ['Control+Alt+M'] })
    const state = toggle.start()
    expect(state.registered).toBe(false)
    expect(state.error).toBeTruthy()
  })

  it('carries the platform so the panel labels modifiers the way this OS does', () => {
    expect(controller({ platform: 'darwin' }).toggle.start().platform).toBe('darwin')
    expect(controller({ platform: 'win32' }).toggle.start().platform).toBe('win32')
  })
})

describe('createToggleShortcut — applying a new accelerator', () => {
  it('releases the old combination before claiming the new one', () => {
    const { toggle, events } = controller({ initial: 'Control+Alt+M' })
    toggle.start()
    events.length = 0
    toggle.apply('Control+Alt+N')
    expect(events).toEqual(['unregister:Control+Alt+M', 'register:Control+Alt+N'])
  })

  it('reports the new accelerator as active and clears the previous error', () => {
    const { toggle } = controller({ initial: 'Control+Alt+M', taken: ['Control+Alt+M'] })
    expect(toggle.start().error).toBeTruthy()
    const state = toggle.apply('Control+Alt+N')
    expect(state).toEqual({ accelerator: 'Control+Alt+N', registered: true, platform: 'win32' })
  })

  it('stores the canonical spelling of whatever it was handed', () => {
    const { toggle, held } = controller({ initial: 'Control+Alt+M' })
    toggle.start()
    expect(toggle.apply('shift+ctrl+n').accelerator).toBe('Control+Shift+N')
    expect(held.has('Control+Shift+N')).toBe(true)
  })

  it('does nothing at all when asked for the combination already working', () => {
    // Re-registering would briefly leave the shortcut unclaimed for no reason.
    const { toggle, events } = controller({ initial: 'Control+Alt+M' })
    toggle.start()
    events.length = 0
    expect(toggle.apply('Control+Alt+M').registered).toBe(true)
    expect(events).toEqual([])
  })

  it('retries the same combination when it is NOT currently registered', () => {
    // How "reset to default" rescues a startup failure: the other application
    // holding the combination may well have quit since.
    const { toggle, events, taken } = controller({
      initial: 'Control+Alt+M',
      taken: ['Control+Alt+M']
    })
    expect(toggle.start().registered).toBe(false)
    taken.delete('Control+Alt+M')
    events.length = 0
    expect(toggle.apply('Control+Alt+M').registered).toBe(true)
    expect(events).toContain('register:Control+Alt+M')
  })
})

describe('createToggleShortcut — failure and revert', () => {
  it('keeps the previously working combination when the new one is taken', () => {
    const { toggle, held } = controller({ initial: 'Control+Alt+M', taken: ['Control+Alt+N'] })
    toggle.start()
    const state = toggle.apply('Control+Alt+N')
    // Never render a shortcut as active when its registration failed: the state
    // must name the combination that actually works.
    expect(state.accelerator).toBe('Control+Alt+M')
    expect(state.registered).toBe(true)
    expect(held.has('Control+Alt+M')).toBe(true)
    expect(held.has('Control+Alt+N')).toBe(false)
  })

  it('explains the refusal naming both the rejected and the kept combination', () => {
    const { toggle } = controller({ initial: 'Control+Alt+M', taken: ['Control+Alt+N'] })
    toggle.start()
    const reason = toggle.apply('Control+Alt+N').error ?? ''
    expect(reason).toMatch(/another application/i)
    expect(reason).toContain('Ctrl + Alt + N')
    expect(reason).toContain('Ctrl + Alt + M')
  })

  it('uses the platform key names in the refusal it shows the user', () => {
    const { toggle } = controller({
      initial: 'Command+Alt+M',
      taken: ['Command+Alt+N'],
      platform: 'darwin'
    })
    toggle.start()
    const reason = toggle.apply('Command+Alt+N').error ?? ''
    expect(reason).toContain('Cmd + Option + N')
  })

  it('reverts when the new combination makes Electron throw, too', () => {
    const { toggle } = controller({ initial: 'Control+Alt+M', throwsOn: ['Control+Alt+N'] })
    toggle.start()
    const state = toggle.apply('Control+Alt+N')
    expect(state.accelerator).toBe('Control+Alt+M')
    expect(state.registered).toBe(true)
  })

  it('admits when the revert also fails, so the panel never claims a live shortcut', () => {
    // Worst case: the new combination is taken AND the old one was grabbed by
    // something else in the meantime. Pretending either works would be a lie.
    const { toggle, taken } = controller({ initial: 'Control+Alt+M', taken: ['Control+Alt+N'] })
    toggle.start()
    taken.add('Control+Alt+M')
    const state = toggle.apply('Control+Alt+N')
    expect(state.accelerator).toBe('Control+Alt+M')
    expect(state.registered).toBe(false)
    expect(state.error).toBeTruthy()
  })

  it('refuses an unusable accelerator without touching the working registration', () => {
    const { toggle, events, held } = controller({ initial: 'Control+Alt+M' })
    toggle.start()
    events.length = 0
    const state = toggle.apply('Shift+P')
    expect(events).toEqual([])
    expect(held.has('Control+Alt+M')).toBe(true)
    expect(state.accelerator).toBe('Control+Alt+M')
    expect(state.registered).toBe(true)
    expect(state.error).toMatch(/Shift/)
  })

  it('refuses a payload that is not an accelerator at all', () => {
    const { toggle } = controller({ initial: 'Control+Alt+M' })
    toggle.start()
    expect(toggle.apply('').registered).toBe(true)
    expect(toggle.apply('').error).toBeTruthy()
    expect(toggle.apply('nonsense').accelerator).toBe('Control+Alt+M')
  })
})

describe('createToggleShortcut — state and disposal', () => {
  it('answers with the current state without re-registering anything', () => {
    const { toggle, events } = controller({ initial: 'Control+Alt+M' })
    toggle.start()
    events.length = 0
    expect(toggle.state()).toEqual({
      accelerator: 'Control+Alt+M',
      registered: true,
      platform: 'win32'
    })
    expect(events).toEqual([])
  })

  it('hands out snapshots a caller cannot mutate into the controller', () => {
    const { toggle } = controller({ initial: 'Control+Alt+M' })
    toggle.start()
    const snapshot = toggle.state()
    snapshot.accelerator = 'Control+Alt+TAMPERED'
    snapshot.registered = false
    expect(toggle.state()).toEqual({
      accelerator: 'Control+Alt+M',
      registered: true,
      platform: 'win32'
    })
  })

  it('reports the state before start() without having claimed anything yet', () => {
    const { toggle, events } = controller({ initial: 'Control+Alt+M' })
    expect(toggle.state().accelerator).toBe('Control+Alt+M')
    expect(toggle.state().registered).toBe(false)
    expect(events).toEqual([])
  })

  it('releases every claim on disposal', () => {
    const { toggle, events, held } = controller({ initial: 'Control+Alt+M' })
    toggle.start()
    toggle.dispose()
    expect(events).toContain('unregisterAll')
    expect(held.size).toBe(0)
  })
})

/**
 * The seam src/main/index.ts wires up: the preference file is read, and
 * whatever comes back is what gets claimed from the OS. Covered here because
 * index.ts is the Electron entry point and has no test harness of its own —
 * this exercises everything it does between the two, minus Electron itself.
 */
describe('startup load path — stored preference into a live registration', () => {
  const FILE = 'C:/fake/userData/shortcut-preference-v1.json'

  function bootWith(stored: Record<string, string>, options: { taken?: string[] } = {}) {
    const fs: ShortcutPreferenceFsLike = {
      readFile: async (path) => {
        const content = stored[path]
        if (content === undefined) throw new Error(`ENOENT: ${path}`)
        return content
      },
      writeFile: async () => undefined,
      rename: async () => undefined
    }
    const shortcut = fakeGlobalShortcut({ taken: options.taken })
    return {
      ...shortcut,
      async boot() {
        const accelerator = await createShortcutPreferenceStore({ filePath: FILE, fs }).load()
        return createToggleShortcut({
          initial: accelerator,
          onToggle: () => undefined,
          globalShortcut: shortcut.api,
          platform: 'win32'
        }).start()
      }
    }
  }

  it('claims the accelerator a previous run saved', async () => {
    const { boot, held } = bootWith({ [FILE]: '{"accelerator":"Control+Alt+M"}\n' })
    expect((await boot()).accelerator).toBe('Control+Alt+M')
    expect(held.has('Control+Alt+M')).toBe(true)
  })

  it('claims the documented default on a first run, with no preference file', async () => {
    const { boot, held } = bootWith({})
    const state = await boot()
    expect(state.accelerator).toBe(DEFAULT_TOGGLE_ACCELERATOR)
    expect(state.registered).toBe(true)
    expect(held.has(DEFAULT_TOGGLE_ACCELERATOR)).toBe(true)
  })

  it('still ends up with a WORKING shortcut when the file is corrupt', async () => {
    // A broken preference must degrade to the default, never to no shortcut.
    const { boot, held } = bootWith({ [FILE]: '{"accelerator":' })
    expect((await boot()).registered).toBe(true)
    expect(held.has(DEFAULT_TOGGLE_ACCELERATOR)).toBe(true)
  })

  it('reports the stored accelerator as unavailable when the OS refuses it', async () => {
    // The startup failure that used to reach only the console now arrives as
    // state the settings panel renders.
    const { boot } = bootWith(
      { [FILE]: '{"accelerator":"Control+Alt+M"}\n' },
      {
        taken: ['Control+Alt+M']
      }
    )
    const state = await boot()
    expect(state.accelerator).toBe('Control+Alt+M')
    expect(state.registered).toBe(false)
    expect(state.error).toMatch(/another application/i)
  })
})
