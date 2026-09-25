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

function readyServer(url = 'http://127.0.0.1:4096'): {
  ensure: () => Promise<ControlServerStartResult>
} {
  return { ensure: vi.fn().mockResolvedValue({ ok: true, url, readPassword: () => 'secret' }) }
}

function fetchReturning(connected: string[]): OpenCodeConnectedFetch {
  return vi.fn().mockResolvedValue({ status: 200, json: async () => ({ connected }) })
}

describe('createOpenCodeLaunchCredentialGate', () => {
  it('never starts the control server for an id with no readable provider', async () => {
    const controlServer = readyServer()
    const fetch = fetchReturning(['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate('nonsense')).resolves.toEqual({ kind: 'ready' })
    expect(controlServer.ensure).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never starts the control server when no model was chosen', async () => {
    const controlServer = readyServer()
    const fetch = fetchReturning(['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate(undefined)).resolves.toEqual({ kind: 'ready' })
    expect(controlServer.ensure).not.toHaveBeenCalled()
  })

  it('ensures the server, reads /provider, and decides ready when the provider is connected', async () => {
    const controlServer = readyServer('http://127.0.0.1:4096')
    const fetch = fetchReturning(['opencode', 'anthropic'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate('anthropic/claude-3-5')).resolves.toEqual({ kind: 'ready' })
    expect(controlServer.ensure).toHaveBeenCalledTimes(1)
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:4096/provider')
  })

  it('reports credential-missing when the provider is absent from connected', async () => {
    const controlServer = readyServer()
    const fetch = fetchReturning(['opencode'])
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    await expect(gate('anthropic/claude-3-5')).resolves.toEqual({
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

    const outcome = await gate('anthropic/claude-3-5')
    expect(outcome.kind).toBe('check-failed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails open with check-failed when the read itself fails', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeConnectedFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch })

    const outcome = await gate('anthropic/claude-3-5')
    expect(outcome.kind).toBe('check-failed')
  })

  it('carries a human-readable detail on every check-failed outcome, for the caller to log', async () => {
    const controlServer = {
      ensure: vi.fn().mockResolvedValue({ ok: false, reason: 'timed-out' })
    }
    const gate = createOpenCodeLaunchCredentialGate({ controlServer, fetch: fetchReturning([]) })

    const outcome = await gate('anthropic/claude-3-5')
    expect(outcome).toMatchObject({ kind: 'check-failed' })
    if (outcome.kind === 'check-failed') {
      expect(outcome.detail).toContain('timed-out')
    }
  })
})
