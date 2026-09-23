import { describe, expect, it } from 'vitest'
import { FakeHookFs } from '../hooks/fakeHookFs'
import type { HookServerLike } from '../hooks/hookChannel'
import { OPENCODE_PUSH_ROUTE } from '../hooks/hookCommand'
import { HookListener } from '../hooks/hookListener'
import { HOOK_TOKEN_FILE } from '../hooks/hookToken'
import { OpenCodePluginChannel, OPENCODE_PLUGIN_ENABLED_MARKER } from './openCodePluginChannel'
import { OPENCODE_PLUGIN_FILE, OPENCODE_PLUGIN_HEADER } from './openCodePluginInstaller'

const USER_DATA = 'C:/Users/j/AppData/Roaming/DwarfAI-Miners'
const PLUGIN_DIR = 'C:/Users/j/.config/opencode/plugin'
const PLUGIN_PATH = `${PLUGIN_DIR}/${OPENCODE_PLUGIN_FILE}`
const MARKER = `${USER_DATA}/${OPENCODE_PLUGIN_ENABLED_MARKER}`

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

function harness(overrides: { pluginDir?: string | null } = {}) {
  const fs = new FakeHookFs()
  fs.addDir(USER_DATA)
  const server = new FakeServer()
  const warnings: string[] = []
  const listener = new HookListener({
    fs,
    userDataDir: USER_DATA,
    port: 47821,
    onEvent: () => undefined,
    createServer: () => server
  })
  const channel = new OpenCodePluginChannel({
    fs,
    pluginDir: overrides.pluginDir === undefined ? PLUGIN_DIR : overrides.pluginDir,
    userDataDir: USER_DATA,
    listener,
    warn: (message) => warnings.push(message)
  })
  return { fs, server, listener, channel, warnings }
}

describe('OpenCodePluginChannel.enable (#588 T6)', () => {
  it('serves the OpenCode route on its own -- no Claude consent needed -- and writes the plugin', async () => {
    const { fs, server, listener, channel } = harness()
    expect(await channel.enable()).toEqual({ enabled: true })
    expect(server.started).toBe(1)
    expect(listener.isOpen('opencode')).toBe(true)
    expect(listener.isOpen('claude')).toBe(false)
    expect(channel.isActive()).toBe(true)
    expect(fs.read(PLUGIN_PATH)?.startsWith(OPENCODE_PLUGIN_HEADER)).toBe(true)
    expect(await fs.exists(MARKER)).toBe(true)
  })

  it('bakes this install token and the real push address into the file it writes', async () => {
    const { fs, channel } = harness()
    await channel.enable()
    const token = fs.read(`${USER_DATA}/${HOOK_TOKEN_FILE}`)!
    const written = fs.read(PLUGIN_PATH)!
    expect(written).toContain(`'http://127.0.0.1:47821${OPENCODE_PUSH_ROUTE}'`)
    expect(written).toContain(`'${token}'`)
  })

  it('is idempotent when already on', async () => {
    const { server, channel } = harness()
    await channel.enable()
    expect(await channel.enable()).toEqual({ enabled: true })
    expect(server.started).toBe(1)
  })

  it('writes nothing and remembers nothing when the port cannot be bound', async () => {
    const { fs, server, listener, channel } = harness()
    server.failNextStart = new Error('EADDRINUSE')
    const result = await channel.enable()
    expect(result.enabled).toBe(false)
    expect(result.error).toMatch(/port/i)
    expect(fs.read(PLUGIN_PATH)).toBeUndefined()
    expect(await fs.exists(MARKER)).toBe(false)
    expect(listener.isOpen('opencode')).toBe(false)
  })

  it('closes the route again when the plugin cannot be written, leaving a foreign file untouched', async () => {
    const { fs, listener, channel } = harness()
    fs.addDir(PLUGIN_DIR)
    fs.addFile(PLUGIN_PATH, 'export const theirs = 1\n')
    const result = await channel.enable()
    expect(result.enabled).toBe(false)
    expect(result.error).toMatch(/did not write/i)
    expect(fs.read(PLUGIN_PATH)).toBe('export const theirs = 1\n')
    expect(listener.isListening()).toBe(false)
    expect(await fs.exists(MARKER)).toBe(false)
  })

  it('refuses with a reason, and binds nothing, when the OpenCode config directory cannot be located', async () => {
    const { server, channel } = harness({ pluginDir: null })
    const result = await channel.enable()
    expect(result.enabled).toBe(false)
    expect(result.error).toMatch(/XDG_CONFIG_HOME/)
    expect(server.started).toBe(0)
  })
})

describe('OpenCodePluginChannel.disable (#588 T6)', () => {
  it('stops serving the route, deletes exactly what it wrote and forgets the choice', async () => {
    const { fs, server, channel } = harness()
    await channel.enable()
    await channel.disable()
    expect(server.stopped).toBe(1)
    expect(channel.isActive()).toBe(false)
    expect(fs.read(PLUGIN_PATH)).toBeUndefined()
    // It created the directory, so it takes it away again.
    expect(await fs.exists(PLUGIN_DIR)).toBe(false)
    expect(await fs.exists(MARKER)).toBe(false)
  })

  it('leaves a plugin directory that existed before it', async () => {
    const { fs, channel } = harness()
    fs.addDir(PLUGIN_DIR)
    await channel.enable()
    await channel.disable()
    expect(await fs.exists(PLUGIN_DIR)).toBe(true)
  })

  it('leaves the Claude route listening -- the two consents are independent', async () => {
    const { server, listener, channel } = harness()
    await listener.open('claude')
    await channel.enable()
    await channel.disable()
    expect(server.stopped).toBe(0)
    expect(listener.isOpen('claude')).toBe(true)
  })

  it('still forgets the choice when the file cannot be removed', async () => {
    const { fs, channel, warnings } = harness()
    await channel.enable()
    fs.failRemove = (path) => (path.includes(OPENCODE_PLUGIN_FILE) ? new Error('EPERM') : null)
    await channel.disable()
    expect(await fs.exists(MARKER)).toBe(false)
    expect(warnings.join(' ')).toMatch(/EPERM/)
  })
})

describe('OpenCodePluginChannel.restore (#588 T6)', () => {
  it('stays off when the person never opted in', async () => {
    const { server, channel } = harness()
    expect(await channel.restore()).toBeNull()
    expect(server.started).toBe(0)
  })

  it('brings the route back and rewrites the plugin when the marker is there', async () => {
    const { fs, channel } = harness()
    fs.addFile(MARKER, `${OPENCODE_PLUGIN_ENABLED_MARKER}\n`)
    expect(await channel.restore()).toEqual({ enabled: true })
    expect(fs.read(PLUGIN_PATH)?.startsWith(OPENCODE_PLUGIN_HEADER)).toBe(true)
  })

  it('keeps the opt-in when restoring fails', async () => {
    const { fs, server, channel, warnings } = harness()
    fs.addFile(MARKER, `${OPENCODE_PLUGIN_ENABLED_MARKER}\n`)
    server.failNextStart = new Error('EADDRINUSE')
    const result = await channel.restore()
    expect(result?.enabled).toBe(false)
    expect(await fs.exists(MARKER)).toBe(true)
    expect(warnings).toHaveLength(1)
  })

  it('remembers across launches that it created the directory, so a later disable still removes it', async () => {
    const first = harness()
    await first.channel.enable()
    await first.channel.shutdown()

    // A fresh launch over the same disk: the directory now exists, but it is
    // still the one this app made.
    const listener = new HookListener({
      fs: first.fs,
      userDataDir: USER_DATA,
      port: 47821,
      onEvent: () => undefined,
      createServer: () => new FakeServer()
    })
    const relaunched = new OpenCodePluginChannel({
      fs: first.fs,
      pluginDir: PLUGIN_DIR,
      userDataDir: USER_DATA,
      listener
    })
    await relaunched.restore()
    await relaunched.disable()
    expect(await first.fs.exists(PLUGIN_DIR)).toBe(false)
  })
})

describe('OpenCodePluginChannel.shutdown (#588 T6)', () => {
  it('releases the route but leaves the plugin and the opt-in for the next launch', async () => {
    const { fs, server, channel } = harness()
    await channel.enable()
    await channel.shutdown()
    expect(server.stopped).toBe(1)
    expect(channel.isActive()).toBe(false)
    expect(fs.read(PLUGIN_PATH)).toBeDefined()
    expect(await fs.exists(MARKER)).toBe(true)
  })
})
