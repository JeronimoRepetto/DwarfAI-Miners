import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DwarfAiMinersApi } from './index'

/**
 * The preload runs `contextBridge.exposeInMainWorld` at import time, so the
 * whole electron surface is faked before the module loads and the exposed api
 * object is captured for inspection. What is under test is the CONTRACT: the
 * exact channel each member speaks on, the payload it forwards, and that the
 * value handed back to the renderer is the main process's verdict untouched.
 */
const exposed = new Map<string, unknown>()
const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
const send = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.set(key, value)
    }
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => invoke(channel, ...args),
    send: (channel: string, ...args: unknown[]) => send(channel, ...args),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

let api: DwarfAiMinersApi

beforeAll(async () => {
  await import('./index')
  api = exposed.get('api') as DwarfAiMinersApi
})

describe('preload always-on-top contract', () => {
  it('exposes the pin surface next to the existing members instead of replacing them', () => {
    expect(typeof api.getAlwaysOnTop).toBe('function')
    expect(typeof api.setAlwaysOnTop).toBe('function')
    // Guard against an accidental surface rewrite: the pre-existing members
    // must still be there.
    expect(typeof api.hidePanel).toBe('function')
    expect(typeof api.getMines).toBe('function')
    expect(typeof api.onMinesUpdated).toBe('function')
    expect(typeof api.activateDwarf).toBe('function')
    expect(typeof api.sendDwarfText).toBe('function')
    expect(typeof api.kickDwarf).toBe('function')
    expect(typeof api.getToggleShortcut).toBe('function')
    expect(typeof api.setToggleShortcut).toBe('function')
  })

  it('asks for the current state on the panel:getAlwaysOnTop channel with no payload', async () => {
    invoke.mockResolvedValueOnce(true)
    await expect(api.getAlwaysOnTop()).resolves.toBe(true)
    expect(invoke).toHaveBeenLastCalledWith('panel:getAlwaysOnTop')
  })

  it('requests a toggle on panel:setAlwaysOnTop with exactly the desired boolean', async () => {
    invoke.mockResolvedValueOnce(false)
    await api.setAlwaysOnTop(false)
    expect(invoke).toHaveBeenLastCalledWith('panel:setAlwaysOnTop', false)
  })

  it('hands back the main-process verdict, not the wish', async () => {
    // Main may refuse (platform ignored the hint): the renderer must receive
    // that real state so it never renders an always-on-top it does not have.
    invoke.mockResolvedValueOnce(true)
    await expect(api.setAlwaysOnTop(false)).resolves.toBe(true)
  })
})

describe('preload panel-toggle shortcut contract', () => {
  it('asks for the current shortcut on the shortcut:get channel with no payload', async () => {
    const state = { accelerator: 'Control+Alt+Shift+P', registered: true, platform: 'win32' }
    invoke.mockResolvedValueOnce(state)
    await expect(api.getToggleShortcut()).resolves.toEqual(state)
    expect(invoke).toHaveBeenLastCalledWith('shortcut:get')
  })

  it('requests a change on shortcut:set with exactly the recorded accelerator', async () => {
    invoke.mockResolvedValueOnce({
      accelerator: 'Control+Alt+M',
      registered: true,
      platform: 'win32'
    })
    await api.setToggleShortcut('Control+Alt+M')
    expect(invoke).toHaveBeenLastCalledWith('shortcut:set', 'Control+Alt+M')
  })

  it('hands back the main-process verdict, not the requested combination', async () => {
    // The combination was taken, so main kept the old one: the renderer must
    // receive THAT, or the settings panel would show a dead shortcut as live.
    const reverted = {
      accelerator: 'Control+Alt+Shift+P',
      registered: true,
      error: 'Ctrl + Alt + M is already in use by another application.',
      platform: 'win32'
    }
    invoke.mockResolvedValueOnce(reverted)
    await expect(api.setToggleShortcut('Control+Alt+M')).resolves.toEqual(reverted)
  })

  it('collapses a non-string payload to a string before it crosses the bridge', async () => {
    // Same discipline as setAlwaysOnTop: main's boundary check should only ever
    // have to reason about a clean string.
    invoke.mockResolvedValueOnce({
      accelerator: 'Control+Alt+Shift+P',
      registered: true,
      platform: 'win32'
    })
    await (api.setToggleShortcut as unknown as (value: unknown) => Promise<unknown>)(42)
    expect(invoke).toHaveBeenLastCalledWith('shortcut:set', '')
  })
})
