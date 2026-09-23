import { describe, expect, it } from 'vitest'
import { FakeHookFs } from './fakeHookFs'
import type { HookServerLike } from './hookChannel'
import { HookListener } from './hookListener'
import type { HookServerOptions } from './hookServer'
import { HOOK_TOKEN_FILE } from './hookToken'

const USER_DATA = 'C:/Users/j/AppData/Roaming/DwarfAI-Miners'

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

function harness(): {
  fs: FakeHookFs
  server: FakeServer
  listener: HookListener
  built: HookServerOptions[]
} {
  const fs = new FakeHookFs()
  fs.addDir(USER_DATA)
  const server = new FakeServer()
  const built: HookServerOptions[] = []
  const listener = new HookListener({
    fs,
    userDataDir: USER_DATA,
    port: 47821,
    onEvent: () => undefined,
    createServer: (options) => {
      built.push(options)
      return server
    }
  })
  return { fs, server, listener, built }
}

describe('HookListener (#588 T6, F5)', () => {
  it('starts the listener for the OpenCode route alone -- Claude is not a prerequisite', async () => {
    const { fs, server, listener } = harness()
    const result = await listener.open('opencode')
    expect(result).toEqual({ opened: true, token: fs.read(`${USER_DATA}/${HOOK_TOKEN_FILE}`) })
    expect(server.started).toBe(1)
    expect(listener.isOpen('opencode')).toBe(true)
    expect(listener.isOpen('claude')).toBe(false)
  })

  it('serves only the routes that were opened', async () => {
    const { listener, built } = harness()
    await listener.open('opencode')
    const gate = built[0]?.isRouteOpen
    expect(gate?.('opencode')).toBe(true)
    expect(gate?.('claude')).toBe(false)
    await listener.open('claude')
    expect(gate?.('claude')).toBe(true)
  })

  it('shares one server and one token between both routes', async () => {
    const { server, listener } = harness()
    const first = await listener.open('claude')
    const second = await listener.open('opencode')
    expect(server.started).toBe(1)
    expect(first.opened && second.opened && first.token === second.token).toBe(true)
  })

  it('keeps listening while one route is still open, and stops with the last one', async () => {
    const { server, listener } = harness()
    await listener.open('claude')
    await listener.open('opencode')
    await listener.close('claude')
    expect(server.stopped).toBe(0)
    expect(listener.isOpen('opencode')).toBe(true)
    await listener.close('opencode')
    expect(server.stopped).toBe(1)
    expect(listener.isListening()).toBe(false)
  })

  it('reports a port it cannot bind and leaves the route closed', async () => {
    const { server, listener } = harness()
    server.failNextStart = new Error('EADDRINUSE 127.0.0.1:47821')
    const result = await listener.open('opencode')
    expect(result.opened).toBe(false)
    expect(result.opened ? '' : result.error).toMatch(/Port 47821 could not be opened/)
    expect(listener.isOpen('opencode')).toBe(false)
    expect(listener.isListening()).toBe(false)
  })

  it('reports a token it cannot create instead of starting without one', async () => {
    const { fs, server, listener } = harness()
    fs.failWrite = (path) => (path.includes(HOOK_TOKEN_FILE) ? new Error('EACCES') : null)
    const result = await listener.open('claude')
    expect(result).toEqual({ opened: false, error: 'EACCES' })
    expect(server.started).toBe(0)
  })

  it('closes every route and releases the port on shutdown', async () => {
    const { server, listener } = harness()
    await listener.open('claude')
    await listener.open('opencode')
    await listener.shutdown()
    expect(server.stopped).toBe(1)
    expect(listener.isOpen('claude')).toBe(false)
    expect(listener.isOpen('opencode')).toBe(false)
  })

  it('treats closing a route that was never opened as a no-op', async () => {
    const { server, listener } = harness()
    await listener.close('opencode')
    expect(server.stopped).toBe(0)
  })
})
