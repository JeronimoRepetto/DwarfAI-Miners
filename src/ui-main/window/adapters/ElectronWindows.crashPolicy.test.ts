import { beforeEach, describe, expect, it } from 'vitest'
import { createModeWindowRegistry } from '../application/modeWindowRegistry'
import {
  ElectronWindows,
  RENDERER_CRASHED_MESSAGE,
  RENDERER_CRASH_WINDOW_MS,
  RENDERER_HANG_MS,
  showRendererCrashedMessage,
  type CrashChoice,
  type RendererTimers
} from './ElectronWindows'
import { FakeBrowserWindow } from './fakes/FakeBrowserWindow'

const APP_ENTRY = 'file:///opt/dwarfai/resources/app.asar/out/renderer/index.html'

/** A fake clock: time moves only when the test advances it, and due timers fire in order. */
class FakeTimers implements RendererTimers {
  private time = 0
  private nextHandle = 1
  private readonly pending = new Map<number, { at: number; fire: () => void }>()

  now(): number {
    return this.time
  }

  setTimeout(fire: () => void, ms: number): number {
    const handle = this.nextHandle++
    this.pending.set(handle, { at: this.time + ms, fire })
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number)
  }

  advance(ms: number): void {
    const until = this.time + ms
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      this.pending.delete(due[0])
      this.time = due[1].at
      due[1].fire()
    }
    this.time = until
  }
}

/** The crash message: each time it is shown, the test answers it later through `answer`. */
function scriptedMessage() {
  const shown: FakeBrowserWindow[] = []
  const answers: ((choice: CrashChoice) => void)[] = []
  return {
    shown,
    show: (window: FakeBrowserWindow): Promise<CrashChoice> => {
      shown.push(window)
      return new Promise((resolve) => answers.push(resolve))
    },
    async answer(choice: CrashChoice): Promise<void> {
      const resolve = answers.shift()
      if (resolve === undefined) throw new Error('no crash message is open')
      resolve(choice)
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

function setup() {
  const timers = new FakeTimers()
  const message = scriptedMessage()
  const registry = createModeWindowRegistry()
  const windows = new ElectronWindows({
    BrowserWindow: FakeBrowserWindow,
    preload: '/app/out/preload/index.cjs',
    icon: '/app/resources/app-icon.png',
    appEntry: APP_ENTRY,
    registry,
    panelStart: () => ({ alwaysOnTop: false, bounds: { x: 0, y: 0, width: 518, height: 1032 } }),
    timers,
    crashMessage: (window) => message.show(window as FakeBrowserWindow)
  })
  windows.panel()
  const window = FakeBrowserWindow.built.at(-1)!
  const loads = () => window.calls.filter((call) => call === `loadURL ${APP_ENTRY}`).length
  return { timers, message, registry, window, loads }
}

beforeEach(() => FakeBrowserWindow.reset())

describe('renderer crash and hang policy (ADR-019 item 11; 13 FM-043, FM-044)', () => {
  it('[FM-043] a first renderer crash reloads the window once and keeps the session store', () => {
    const { window, registry, loads, message } = setup()
    expect(loads(), 'the page loaded at creation').toBe(1)
    window.webContents.crash('crashed')
    expect(loads(), 'one automatic reload from the app entry').toBe(2)
    expect(message.shown, 'no message on a first crash').toEqual([])
    // The UI-main session store lives in Electron main beside the window, not in the renderer: the window is reloaded
    // in place, never closed and rebuilt, so nothing that clears the store on a window's departure runs.
    expect(window.calls).not.toContain('close')
    expect(window.isDestroyed()).toBe(false)
    expect(registry.has(window.webContents.id), 'still a registered mode window').toBe(true)
  })

  it('[FM-043] a second crash within 60 s shows one message and does not reload', () => {
    const { window, timers, loads, message } = setup()
    window.webContents.crash('crashed')
    timers.advance(RENDERER_CRASH_WINDOW_MS - 1)
    window.webContents.crash('oom')
    expect(loads(), 'no second automatic reload').toBe(2)
    expect(message.shown).toEqual([window])
    window.webContents.crash('crashed')
    expect(message.shown, 'still exactly one message').toEqual([window])
    expect(loads()).toBe(2)
  })

  it('[FM-043] a crash 60 s or more after the first is a first crash again', () => {
    const { window, timers, loads, message } = setup()
    window.webContents.crash('crashed')
    timers.advance(RENDERER_CRASH_WINDOW_MS)
    window.webContents.crash('crashed')
    expect(loads()).toBe(3)
    expect(message.shown).toEqual([])
  })

  it('[FM-043] Reload on the message reloads the window in place and restarts the 60 s count', async () => {
    const { window, timers, loads, message } = setup()
    window.webContents.crash('crashed')
    window.webContents.crash('crashed')
    timers.advance(10_000)
    expect(message.shown, 'the message of the second crash').toEqual([window])
    await message.answer('reload')
    expect(loads(), 'Reload reloads the page').toBe(3)
    expect(window.calls).not.toContain('close')
    timers.advance(RENDERER_CRASH_WINDOW_MS - 1)
    window.webContents.crash('crashed')
    expect(message.shown, 'a crash within 60 s of Reload is a second crash').toHaveLength(2)
    expect(loads()).toBe(3)
  })

  it('[FM-043] dismissing the message closes that window', async () => {
    const { window, registry, message } = setup()
    window.webContents.crash('crashed')
    window.webContents.crash('crashed')
    expect(message.shown, 'the message of the second crash').toEqual([window])
    await message.answer('dismiss')
    expect(window.calls).toContain('close')
    expect(registry.has(window.webContents.id)).toBe(false)
  })

  it('[FM-043] a clean exit of the renderer is not a crash', () => {
    const { window, loads, message } = setup()
    window.webContents.crash('clean-exit')
    window.webContents.crash('clean-exit')
    expect(loads()).toBe(1)
    expect(message.shown).toEqual([])
  })

  it('[FM-044] 30 s unresponsive with no responsive event is treated as a crash', () => {
    const { window, timers, loads } = setup()
    window.webContents.emit('unresponsive')
    timers.advance(RENDERER_HANG_MS - 1)
    expect(window.calls).not.toContain('forcefullyCrashRenderer')
    timers.advance(1)
    expect(window.calls, 'the hung renderer is ended').toContain('forcefullyCrashRenderer')
    expect(loads(), 'then reloaded as after a first crash').toBe(2)
  })

  it('[FM-044] a responsive event before 30 s cancels the hang', () => {
    const { window, timers, loads } = setup()
    window.webContents.emit('unresponsive')
    timers.advance(RENDERER_HANG_MS - 1)
    window.webContents.emit('responsive')
    timers.advance(RENDERER_HANG_MS)
    expect(window.calls).not.toContain('forcefullyCrashRenderer')
    expect(loads()).toBe(1)
  })

  it('[FM-043] the crash message is a native box parented to its window, with marked placeholder copy', async () => {
    const asked: { parent: unknown; options: { message: string; buttons: string[] } }[] = []
    const dialog = {
      showMessageBox: (parent: unknown, options: { message: string; buttons: string[] }) => {
        asked.push({ parent, options })
        return Promise.resolve({ response: asked.length === 1 ? 0 : 1 })
      }
    }
    const parent = { id: 'window' }
    expect(await showRendererCrashedMessage(dialog, parent)).toBe('reload')
    expect(await showRendererCrashedMessage(dialog, parent)).toBe('dismiss')
    expect(asked[0]?.parent).toBe(parent)
    expect(asked[0]?.options.message).toBe(RENDERER_CRASHED_MESSAGE.message)
    expect(asked[0]?.options.buttons).toEqual([
      RENDERER_CRASHED_MESSAGE.reload,
      RENDERER_CRASHED_MESSAGE.dismiss
    ])
    // Never invented copy (AGENTS.md §8.1): every string is the marked placeholder of the design request.
    for (const text of [
      RENDERER_CRASHED_MESSAGE.message,
      RENDERER_CRASHED_MESSAGE.reload,
      RENDERER_CRASHED_MESSAGE.dismiss
    ]) {
      expect(text).toMatch(/^⟦COPY NEEDED: DG "renderer crashed".*⟧$/)
    }
  })
})
