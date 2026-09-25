import { describe, expect, it, vi } from 'vitest'
import type { ControlServerStartResult } from './controlServer'
import {
  createOpenCodeLaunchCredentialGate,
  type OpenCodeConnectedFetch
} from './launchCredentialGate'

/**
 * Issue #597 T3. Composes T1's control server with T2's reader and decision
 * into the one call `AgentRuntime.launchAgent` makes before spawning an
 * OpenCode session — over injected fakes for both, so nothing here starts a
 * real process or reaches a real network.
 */

/** An arbitrary mine folder — never read for its own sake, only threaded through to `/config`. */
const DIRECTORY = 'C:\\mines\\dwarf-pit'

function readyServer(url = 'http://127.0.0.1:4096'): {
  ensure: () => Promise<ControlServerStartResult>
} {
  return { ensure: vi.fn().mockResolvedValue({ ok: true, url, readPassword: () => 'secret' }) }
}

function fetchReturning(connected: string[]): OpenCodeConnectedFetch {
  return vi.fn().mockResolvedValue({ status: 200, json: async () => ({ connected }) })
}

/**
 * Routes by path: `/config` answers `configBody`, `/provider` answers
 * `{connected}` — the shape the gate's own two GETs need told apart, since
 * #597 T3b's "no model chosen" path can call both in one `gate()`.
 */
function fetchRouting(configBody: unknown, connected: string[]): OpenCodeConnectedFetch {
  return vi.fn().mockImplementation(async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/config') return { status: 200, json: async () => configBody }
    if (path === '/provider') return { status: 200, json: async () => ({ connected }) }
    throw new Error(`unexpected path in test fetch: ${path}`)
  })
}

describe('createOpenCodeLaunchCredentialGate', () => {
  it('never starts the control server for an id with no readable provider', async () => {
    const controlServer = readyServer()
    const fetch = fetchReturning(['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate('nonsense', DIRECTORY)).resolves.toEqual({ kind: 'ready' })
    expect(controlServer.ensure).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ensures the server, reads /provider, and decides ready when the provider is connected', async () => {
    const controlServer = readyServer('http://127.0.0.1:4096')
    const fetch = fetchReturning(['opencode', 'anthropic'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate('anthropic/claude-3-5', DIRECTORY)).resolves.toEqual({ kind: 'ready' })
    expect(controlServer.ensure).toHaveBeenCalledTimes(1)
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:4096/provider')
  })

  it('reports credential-missing when the provider is absent from connected', async () => {
    const controlServer = readyServer()
    const fetch = fetchReturning(['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate('anthropic/claude-3-5', DIRECTORY)).resolves.toEqual({
      kind: 'credential-missing',
      providerId: 'anthropic',
      model: 'anthropic/claude-3-5'
    })
  })

  it('fails open with check-failed when the control server would not start', async () => {
    const controlServer = {
      ensure: vi.fn().mockResolvedValue({ ok: false, reason: 'not-installed' })
    }
    const fetch = fetchReturning(['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    const outcome = await gate('anthropic/claude-3-5', DIRECTORY)
    expect(outcome.kind).toBe('check-failed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails open with check-failed when the read itself fails', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeConnectedFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    const outcome = await gate('anthropic/claude-3-5', DIRECTORY)
    expect(outcome.kind).toBe('check-failed')
  })

  it('carries a human-readable detail on every check-failed outcome, for the caller to log', async () => {
    const controlServer = {
      ensure: vi.fn().mockResolvedValue({ ok: false, reason: 'timed-out' })
    }
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch: fetchReturning([]) })

    const outcome = await gate('anthropic/claude-3-5', DIRECTORY)
    expect(outcome).toMatchObject({ kind: 'check-failed' })
    if (outcome.kind === 'check-failed') {
      expect(outcome.detail).toContain('timed-out')
    }
  })
})

/*
 * #597 T3b. `opencode run` with no model chosen uses the model OpenCode's own
 * config resolves for the launch's folder — a project `opencode.json` there
 * can override the global default (measured live against a real server, see
 * `credentialCheck.test.ts`'s own module doc). AMENDS the T3 test above named
 * "never starts the control server when no model was chosen": that assertion
 * is no longer true on purpose — a launch with no model now has something to
 * check (the folder's configured default) and must start the server to read
 * it, which is exactly the behaviour this block pins instead.
 */
describe('createOpenCodeLaunchCredentialGate — no model chosen (#597 T3b)', () => {
  it('ensures the server and reads /config for the launch folder when no model was chosen', async () => {
    const controlServer = readyServer()
    const fetch = fetchRouting({}, ['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await gate(undefined, DIRECTORY)

    expect(controlServer.ensure).toHaveBeenCalledTimes(1)
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    const configCall = calls.find((call) => new URL(call[0] as string).pathname === '/config')
    expect(configCall).toBeDefined()
    const configUrl = configCall![0] as string
    expect(new URL(configUrl).searchParams.get('directory')).toBe(DIRECTORY)
  })

  it('is ready without ever reading /provider when the folder’s config names no model', async () => {
    const controlServer = readyServer()
    const fetch = fetchRouting({}, ['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate(undefined, DIRECTORY)).resolves.toEqual({ kind: 'ready' })
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some((call) => new URL(call[0] as string).pathname === '/provider')).toBe(false)
  })

  it('is ready without reading /provider when the configured model has no readable provider', async () => {
    const controlServer = readyServer()
    const fetch = fetchRouting({ model: 'nonsense' }, ['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate(undefined, DIRECTORY)).resolves.toEqual({ kind: 'ready' })
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.some((call) => new URL(call[0] as string).pathname === '/provider')).toBe(false)
  })

  it('is ready when the configured model’s provider is connected', async () => {
    const controlServer = readyServer()
    const fetch = fetchRouting({ model: 'opencode/grok-code' }, ['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate(undefined, DIRECTORY)).resolves.toEqual({ kind: 'ready' })
  })

  it('reports credential-missing using the config’s own model, exactly like a chosen one', async () => {
    const controlServer = readyServer()
    const fetch = fetchRouting({ model: 'anthropic/claude-sonnet-5' }, ['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate(undefined, DIRECTORY)).resolves.toEqual({
      kind: 'credential-missing',
      providerId: 'anthropic',
      model: 'anthropic/claude-sonnet-5'
    })
  })

  it('fails open with check-failed when GET /config itself fails', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeConnectedFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    const outcome = await gate(undefined, DIRECTORY)
    expect(outcome).toMatchObject({ kind: 'check-failed' })
    if (outcome.kind === 'check-failed') expect(outcome.detail).toContain('GET /config')
  })

  it('fails open with check-failed when the control server would not start, no model chosen', async () => {
    const controlServer = {
      ensure: vi.fn().mockResolvedValue({ ok: false, reason: 'not-installed' })
    }
    const fetch = fetchRouting({}, ['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    const outcome = await gate(undefined, DIRECTORY)
    expect(outcome.kind).toBe('check-failed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never lets a fake secret elsewhere in the config body reach the outcome', async () => {
    const controlServer = readyServer()
    const fetch = fetchRouting(
      {
        model: 'anthropic/claude-sonnet-5',
        provider: { anthropic: { options: { apiKey: 'sk-FAKESECRET-must-never-leak' } } }
      },
      ['opencode']
    )
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    const outcome = await gate(undefined, DIRECTORY)

    expect(outcome).toEqual({
      kind: 'credential-missing',
      providerId: 'anthropic',
      model: 'anthropic/claude-sonnet-5'
    })
    expect(JSON.stringify(outcome)).not.toContain('FAKESECRET')
  })
})
