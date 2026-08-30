import { beforeEach, describe, expect, it, vi } from 'vitest'
import { containsOurHooks, parseSettingsObject } from './claudeSettings'
import { FakeHookFs } from './fakeHookFs'
import { HOOK_MARKER } from './hookCommand'
import { applyHookToggle, HookChannel, HOOKS_ENABLED_MARKER, isCurlAvailable } from './hookChannel'
import type { HookServerLike, HookToggleTarget } from './hookChannel'
import { SETTINGS_FILE } from './hookInstaller'
import { HOOK_TOKEN_FILE } from './hookToken'

const USER_DATA = 'C:/Users/j/AppData/Roaming/DwarfAI-Miners'
const ROOT = 'C:/Users/j/.claude'
const SETTINGS = `${ROOT}/${SETTINGS_FILE}`
const MARKER = `${USER_DATA}/${HOOKS_ENABLED_MARKER}`

class FakeServer implements HookServerLike {
  port = 47821
  started = 0
  stopped = 0
  failNextStart: Error | null = null

  async start(): Promise<void> {
    if (this.failNextStart) {
      const error = this.failNextStart
      this.failNextStart = null
      throw error
    }
    this.started++
  }

  async stop(): Promise<void> {
    this.stopped++
  }
}

interface Harness {
  fs: FakeHookFs
  server: FakeServer
  channel: HookChannel
  warnings: string[]
}

function harness(overrides: { roots?: string[]; curl?: boolean; settings?: string } = {}): Harness {
  const fs = new FakeHookFs()
  fs.addDir(USER_DATA)
  for (const root of overrides.roots ?? [ROOT]) fs.addDir(root)
  if (overrides.settings !== undefined) fs.addFile(SETTINGS, overrides.settings)

  const server = new FakeServer()
  const warnings: string[] = []
  const channel = new HookChannel({
    fs,
    roots: overrides.roots ?? [ROOT],
    userDataDir: USER_DATA,
    port: 47821,
    platform: 'win32',
    onEvent: () => undefined,
    createServer: () => server,
    curlAvailable: async () => overrides.curl ?? true,
    warn: (message) => warnings.push(message)
  })
  return { fs, server, channel, warnings }
}

describe('HookChannel.enable', () => {
  it('starts the listener, installs the hooks and remembers the choice', async () => {
    const { fs, server, channel } = harness()
    expect(await channel.enable()).toEqual({ enabled: true })
    expect(server.started).toBe(1)
    expect(channel.isActive()).toBe(true)
    expect(containsOurHooks(parseSettingsObject(fs.read(SETTINGS)!))).toBe(true)
    expect(await fs.exists(MARKER)).toBe(true)
  })

  it('writes a hook command carrying this install token and port', async () => {
    const { fs, channel } = harness()
    await channel.enable()
    const token = fs.read(`${USER_DATA}/${HOOK_TOKEN_FILE}`)!
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    const written = fs.read(SETTINGS)!
    expect(written).toContain(`http://127.0.0.1:47821/${HOOK_MARKER}`)
    expect(written).toContain(token)
  })

  it('reuses the same token across enable/disable cycles', async () => {
    const { fs, channel } = harness()
    await channel.enable()
    const first = fs.read(`${USER_DATA}/${HOOK_TOKEN_FILE}`)
    await channel.disable()
    await channel.enable()
    expect(fs.read(`${USER_DATA}/${HOOK_TOKEN_FILE}`)).toBe(first)
  })

  it('is idempotent when already enabled', async () => {
    const { server, channel } = harness()
    await channel.enable()
    expect(await channel.enable()).toEqual({ enabled: true })
    expect(server.started).toBe(1)
  })

  it('refuses with an explained error when curl is not on this machine', async () => {
    const { server, fs, channel } = harness({ curl: false })
    const result = await channel.enable()
    expect(result.enabled).toBe(false)
    expect(result.error).toMatch(/curl/i)
    expect(server.started).toBe(0)
    expect(await fs.exists(MARKER)).toBe(false)
  })

  it('reverts everything when the port cannot be bound', async () => {
    const { server, fs, channel } = harness()
    server.failNextStart = new Error('EADDRINUSE 127.0.0.1:47821')
    const result = await channel.enable()
    expect(result.enabled).toBe(false)
    expect(result.error).toMatch(/EADDRINUSE|port/i)
    // Nothing installed, nothing remembered: the checkbox must go back to off.
    expect(await fs.exists(SETTINGS)).toBe(false)
    expect(await fs.exists(MARKER)).toBe(false)
    expect(channel.isActive()).toBe(false)
  })

  it('stops the listener again when hook installation fails everywhere', async () => {
    const { server, fs, channel } = harness({ settings: '{ not json' })
    const result = await channel.enable()
    expect(result.enabled).toBe(false)
    expect(result.error).toBeDefined()
    expect(server.stopped).toBe(1)
    expect(await fs.exists(MARKER)).toBe(false)
    expect(fs.read(SETTINGS)).toBe('{ not json')
  })

  it('fails when no Claude root exists at all, rather than pretending it worked', async () => {
    const fs = new FakeHookFs()
    fs.addDir(USER_DATA)
    const server = new FakeServer()
    const channel = new HookChannel({
      fs,
      roots: [ROOT],
      userDataDir: USER_DATA,
      port: 47821,
      platform: 'win32',
      onEvent: () => undefined,
      createServer: () => server,
      curlAvailable: async () => true
    })
    const result = await channel.enable()
    expect(result.enabled).toBe(false)
    expect(result.error).toMatch(/claude/i)
    expect(server.stopped).toBe(1)
  })

  it('succeeds when one root works even though another is broken', async () => {
    const second = 'C:/Users/j/.claude-work'
    const { fs, channel, warnings } = harness({
      roots: [ROOT, second],
      settings: '{ not json'
    })
    expect(await channel.enable()).toEqual({ enabled: true })
    expect(containsOurHooks(parseSettingsObject(fs.read(`${second}/${SETTINGS_FILE}`)!))).toBe(true)
    expect(warnings.join(' ')).toMatch(/settings\.json/i)
  })
})

describe('HookChannel.disable', () => {
  it('stops the listener, removes the hooks and forgets the choice', async () => {
    const original = '{\n  "model": "x"\n}\n'
    const { fs, server, channel } = harness({ settings: original })
    await channel.enable()
    await channel.disable()
    expect(server.stopped).toBe(1)
    expect(channel.isActive()).toBe(false)
    expect(fs.read(SETTINGS)).toBe(original)
    expect(await fs.exists(MARKER)).toBe(false)
  })

  it('is safe to call when it was never enabled', async () => {
    const { server, channel } = harness()
    await channel.disable()
    expect(server.stopped).toBe(0)
    expect(channel.isActive()).toBe(false)
  })

  it('still stops listening and forgets the choice when uninstall fails', async () => {
    const { fs, server, channel } = harness()
    await channel.enable()
    fs.failWrite = (path) => (path.includes(SETTINGS_FILE) ? new Error('EPERM') : null)
    await channel.disable()
    expect(server.stopped).toBe(1)
    expect(await fs.exists(MARKER)).toBe(false)
  })
})

describe('HookChannel.restore', () => {
  it('stays off when the user never opted in', async () => {
    const { server, channel } = harness()
    expect(await channel.restore()).toBeNull()
    expect(server.started).toBe(0)
    expect(channel.isActive()).toBe(false)
  })

  it('brings the channel back up when the marker is there', async () => {
    const { fs, server, channel } = harness()
    fs.addFile(MARKER, '')
    expect(await channel.restore()).toEqual({ enabled: true })
    expect(server.started).toBe(1)
  })

  it('re-installs the hooks in case they were removed while the app was closed', async () => {
    const { fs, channel } = harness()
    fs.addFile(MARKER, '')
    await channel.restore()
    expect(containsOurHooks(parseSettingsObject(fs.read(SETTINGS)!))).toBe(true)
  })

  it('keeps the opt-in for the next launch when restoring fails', async () => {
    // A port taken by a leftover instance must not silently cancel a choice
    // the user made on purpose; the checkbox just shows the real state.
    const { fs, server, channel, warnings } = harness()
    fs.addFile(MARKER, '')
    server.failNextStart = new Error('EADDRINUSE')
    const result = await channel.restore()
    expect(result?.enabled).toBe(false)
    expect(channel.isActive()).toBe(false)
    expect(await fs.exists(MARKER)).toBe(true)
    expect(warnings).toHaveLength(1)
  })
})

describe('HookChannel.shutdown', () => {
  it('stops listening but leaves the hooks and the opt-in in place', async () => {
    const { fs, server, channel } = harness()
    await channel.enable()
    await channel.shutdown()
    expect(server.stopped).toBe(1)
    expect(channel.isActive()).toBe(false)
    expect(await fs.exists(MARKER)).toBe(true)
    expect(containsOurHooks(parseSettingsObject(fs.read(SETTINGS)!))).toBe(true)
  })
})

describe('isCurlAvailable', () => {
  let fs: FakeHookFs

  beforeEach(() => {
    fs = new FakeHookFs()
  })

  it('finds the curl.exe Windows 10+ ships in System32', async () => {
    fs.addFile('C:/Windows/System32/curl.exe', '')
    expect(await isCurlAvailable(fs, 'win32', { SystemRoot: 'C:/Windows' })).toBe(true)
  })

  it('honours a relocated Windows directory', async () => {
    fs.addFile('D:/Win/System32/curl.exe', '')
    expect(await isCurlAvailable(fs, 'win32', { SystemRoot: 'D:/Win' })).toBe(true)
  })

  it('reports it missing on a Windows install without it', async () => {
    expect(await isCurlAvailable(fs, 'win32', { SystemRoot: 'C:/Windows' })).toBe(false)
  })

  it.each(['/usr/bin/curl', '/bin/curl'])('finds %s on a unix host', async (path) => {
    fs.addFile(path, '')
    expect(await isCurlAvailable(fs, 'linux', {})).toBe(true)
  })

  it('reports it missing on a unix host without it', async () => {
    expect(await isCurlAvailable(fs, 'darwin', {})).toBe(false)
  })
})

describe('applyHookToggle', () => {
  function target(overrides: Partial<HookToggleTarget> = {}): HookToggleTarget {
    return {
      isActive: () => false,
      enable: async () => ({ enabled: true }),
      disable: async () => undefined,
      ...overrides
    }
  }

  it('leaves the box checked when enabling worked', async () => {
    expect(await applyHookToggle(target(), true)).toEqual({ checked: true })
  })

  it('unchecks the box and carries the reason when enabling failed', async () => {
    const result = await applyHookToggle(
      target({ enable: async () => ({ enabled: false, error: 'Port 47821 is busy' }) }),
      true
    )
    expect(result).toEqual({ checked: false, warning: 'Port 47821 is busy' })
  })

  it('unchecks the box when disabling', async () => {
    const disable = vi.fn(async () => undefined)
    expect(await applyHookToggle(target({ disable }), false)).toEqual({ checked: false })
    expect(disable).toHaveBeenCalledOnce()
  })

  it('reports the real state when the toggle throws outright', async () => {
    const result = await applyHookToggle(
      target({
        isActive: () => true,
        disable: async () => {
          throw new Error('boom')
        }
      }),
      false
    )
    expect(result).toEqual({ checked: true, warning: 'boom' })
  })
})

describe('HookChannel event relay', () => {
  it('hands every accepted event straight to the listener it was given', async () => {
    const onEvent = vi.fn()
    const fs = new FakeHookFs()
    fs.addDir(USER_DATA)
    fs.addDir(ROOT)
    let captured: ((event: unknown) => void) | null = null
    const channel = new HookChannel({
      fs,
      roots: [ROOT],
      userDataDir: USER_DATA,
      port: 47821,
      platform: 'win32',
      onEvent,
      createServer: (options) => {
        captured = options.onEvent as (event: unknown) => void
        return new FakeServer()
      },
      curlAvailable: async () => true
    })
    await channel.enable()
    captured!({ provider: 'claude', event: 'Stop' })
    expect(onEvent).toHaveBeenCalledWith({ provider: 'claude', event: 'Stop' })
  })
})
