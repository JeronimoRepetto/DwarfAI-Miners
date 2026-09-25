import { describe, expect, it, vi } from 'vitest'
import type { ControlServerStartResult } from './controlServer'
import { createOpenCodeLoginService, type OpenCodeLoginFetch } from './loginService'

/**
 * Issue #597 T4. Completing a login over the T1 control server: listing a
 * provider's own auth methods, submitting an API key, and both OAuth routes —
 * all over an INJECTED fetch and control server, on the same fake-fetch terms
 * `credentialCheck.test.ts` and `answerOpenCodePermission.test.ts` already
 * use, so nothing here ever reaches a real network or a live `opencode serve`.
 */

function readyServer(
  url = 'http://127.0.0.1:4096',
  password = 'secret'
): {
  ensure: () => Promise<ControlServerStartResult>
} {
  return { ensure: vi.fn().mockResolvedValue({ ok: true, url, readPassword: () => password }) }
}

function jsonFetch(status: number, body: unknown): OpenCodeLoginFetch {
  return vi.fn().mockResolvedValue({ status, json: async () => body })
}

describe('createOpenCodeLoginService.listAuthMethods', () => {
  it('GETs /provider/auth resolved against the server URL, with Basic auth', async () => {
    const controlServer = readyServer('http://127.0.0.1:4096', 'hunter2')
    const fetch = jsonFetch(200, { anthropic: [{ type: 'api', label: 'API key' }] })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await service.listAuthMethods('anthropic')

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:4096/provider/auth')
    expect(init.method).toBe('GET')
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from('opencode:hunter2').toString('base64')}`
    )
  })

  it('returns only the requested provider’s methods, dropping every other one', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(200, {
      anthropic: [{ type: 'api', label: 'API key' }],
      opencode: [{ type: 'api', label: 'Free' }]
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('anthropic')).resolves.toEqual({
      ok: true,
      methods: [{ type: 'api', label: 'API key' }]
    })
  })

  it('carries prompts through for an OAuth method, as measured on github-copilot', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(200, {
      'github-copilot': [
        {
          type: 'oauth',
          label: 'GitHub Copilot',
          prompts: [
            {
              type: 'select',
              key: 'deploymentType',
              message: 'Which deployment?',
              options: [
                { label: 'Individual', value: 'individual' },
                { label: 'Business', value: 'business', hint: 'Org-managed seats' }
              ]
            }
          ]
        }
      ]
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('github-copilot')).resolves.toEqual({
      ok: true,
      methods: [
        {
          type: 'oauth',
          label: 'GitHub Copilot',
          prompts: [
            {
              type: 'select',
              key: 'deploymentType',
              message: 'Which deployment?',
              options: [
                { label: 'Individual', value: 'individual' },
                { label: 'Business', value: 'business', hint: 'Org-managed seats' }
              ]
            }
          ]
        }
      ]
    })
  })

  it('carries a text prompt’s when-clause through unchanged', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(200, {
      example: [
        {
          type: 'oauth',
          label: 'Example',
          prompts: [
            {
              type: 'text',
              key: 'tenant',
              message: 'Tenant id',
              placeholder: 'acme',
              when: { key: 'deploymentType', op: 'eq', value: 'business' }
            }
          ]
        }
      ]
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    const result = await service.listAuthMethods('example')
    expect(result).toEqual({
      ok: true,
      methods: [
        {
          type: 'oauth',
          label: 'Example',
          prompts: [
            {
              type: 'text',
              key: 'tenant',
              message: 'Tenant id',
              placeholder: 'acme',
              when: { key: 'deploymentType', op: 'eq', value: 'business' }
            }
          ]
        }
      ]
    })
  })

  it('reports an empty list for a provider absent from the answer, rather than an error', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(200, { opencode: [{ type: 'api', label: 'Free' }] })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('nonexistent')).resolves.toEqual({
      ok: true,
      methods: []
    })
  })

  it('reports malformed when the provider’s own entry is not an array', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(200, { anthropic: 'not-an-array' })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('anthropic')).resolves.toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('reports malformed when a method entry is missing its label', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(200, { anthropic: [{ type: 'api' }] })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('anthropic')).resolves.toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('reports malformed when the body cannot be parsed as JSON', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => {
        throw new Error('not json')
      }
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('anthropic')).resolves.toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('reports unauthorized on 401, releasing the body', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi
      .fn()
      .mockResolvedValue({ status: 401, json: async () => ({}), body: { cancel } })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('anthropic')).resolves.toEqual({
      ok: false,
      reason: 'unauthorized'
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('reports refused on any other non-200 status', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(400, { name: 'BadRequest', data: { message: 'nope' } })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('anthropic')).resolves.toEqual({
      ok: false,
      reason: 'refused'
    })
  })

  it('reports unreachable when the request never reaches a server', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('anthropic')).resolves.toEqual({
      ok: false,
      reason: 'unreachable'
    })
  })

  it('tells a timeout apart from an ordinary connection failure', async () => {
    const controlServer = readyServer()
    const timeoutError = new DOMException('The operation was aborted.', 'TimeoutError')
    const fetch: OpenCodeLoginFetch = vi.fn().mockRejectedValue(timeoutError)
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('anthropic')).resolves.toEqual({
      ok: false,
      reason: 'timeout'
    })
  })

  it('reports server-unavailable without ever calling fetch when the control server will not start', async () => {
    const controlServer = {
      ensure: vi.fn().mockResolvedValue({ ok: false, reason: 'not-installed' })
    }
    const fetch = jsonFetch(200, {})
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.listAuthMethods('anthropic')).resolves.toEqual({
      ok: false,
      reason: 'server-unavailable'
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('createOpenCodeLoginService.submitApiKey', () => {
  it('PUTs /auth/{id} with Basic auth and the measured {type:"api",key} body', async () => {
    const controlServer = readyServer('http://127.0.0.1:4096', 'hunter2')
    const fetch = vi.fn().mockImplementation(async () => ({
      status: 200,
      json: async () => true
    })) as unknown as OpenCodeLoginFetch
    // First call is the PUT; the service then re-reads /provider.
    ;(fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/anthropic')) return { status: 200, json: async () => true }
      return { status: 200, json: async () => ({ connected: ['opencode', 'anthropic'] }) }
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await service.submitApiKey('anthropic', 'sk-real-key-123')

    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    const [putUrl, putInit] = calls[0]!
    expect(putUrl).toBe('http://127.0.0.1:4096/auth/anthropic')
    expect(putInit.method).toBe('PUT')
    expect(putInit.headers.authorization).toBe(
      `Basic ${Buffer.from('opencode:hunter2').toString('base64')}`
    )
    expect(JSON.parse(putInit.body)).toEqual({ type: 'api', key: 'sk-real-key-123' })
  })

  it('reports connected: true after a successful write when the re-read confirms it', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/anthropic')) return { status: 200, json: async () => true }
      return { status: 200, json: async () => ({ connected: ['opencode', 'anthropic'] }) }
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.submitApiKey('anthropic', 'sk-real-key')).resolves.toEqual({
      ok: true,
      connected: true
    })
  })

  it('reports connected: false when the re-read does not show the provider as connected', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/anthropic')) return { status: 200, json: async () => true }
      return { status: 200, json: async () => ({ connected: ['opencode'] }) }
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.submitApiKey('anthropic', 'sk-real-key')).resolves.toEqual({
      ok: true,
      connected: false
    })
  })

  it('reports connected: false, never failing the write, when the re-read itself cannot reach the server', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/anthropic')) return { status: 200, json: async () => true }
      throw new Error('ECONNRESET')
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.submitApiKey('anthropic', 'sk-real-key')).resolves.toEqual({
      ok: true,
      connected: false
    })
  })

  it('reports malformed when the PUT does not answer the literal boolean true', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(200, false)
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.submitApiKey('anthropic', 'sk-real-key')).resolves.toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('reports unauthorized on 401', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(401, {})
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.submitApiKey('anthropic', 'sk-real-key')).resolves.toEqual({
      ok: false,
      reason: 'unauthorized'
    })
  })

  it('reports refused on a 400 the way OpenCode’s own validation answers it', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(400, { name: 'BadRequest', data: { message: 'bad shape' } })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.submitApiKey('anthropic', 'sk-real-key')).resolves.toEqual({
      ok: false,
      reason: 'refused'
    })
  })

  it('reports server-unavailable without calling fetch when the control server will not start', async () => {
    const controlServer = { ensure: vi.fn().mockResolvedValue({ ok: false, reason: 'timed-out' }) }
    const fetch = jsonFetch(200, true)
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.submitApiKey('anthropic', 'sk-real-key')).resolves.toEqual({
      ok: false,
      reason: 'server-unavailable'
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never lets the key reach a failing result, in any form, in any field', async () => {
    const SECRET = 'sk-super-secret-marker-should-never-leak-anywhere'
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const service = createOpenCodeLoginService({ controlServer, fetch })

    const result = await service.submitApiKey('anthropic', SECRET)

    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('never lets the key reach a failing result even when the write itself is refused', async () => {
    const SECRET = 'sk-another-secret-marker-should-never-leak'
    const controlServer = readyServer()
    const fetch = jsonFetch(400, { name: 'BadRequest', data: { message: 'bad request' } })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    const result = await service.submitApiKey('anthropic', SECRET)

    expect(JSON.stringify(result)).not.toContain(SECRET)
  })
})

describe('createOpenCodeLoginService.startOAuth', () => {
  it('POSTs /provider/{id}/oauth/authorize with the method index and no inputs field when none were given', async () => {
    const controlServer = readyServer('http://127.0.0.1:4096', 'hunter2')
    const fetch = jsonFetch(200, {
      url: 'https://example.com/authorize',
      method: 'code',
      instructions: 'Paste the code shown after you approve.'
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await service.startOAuth('anthropic', 0)

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:4096/provider/anthropic/oauth/authorize')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from('opencode:hunter2').toString('base64')}`
    )
    expect(JSON.parse(init.body)).toEqual({ method: 0 })
  })

  it('includes inputs when the chosen method carried prompts', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(200, {
      url: 'https://example.com/authorize',
      method: 'auto',
      instructions: 'Finish in your browser.'
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await service.startOAuth('github-copilot', 0, { deploymentType: 'business' })

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(JSON.parse(init.body)).toEqual({ method: 0, inputs: { deploymentType: 'business' } })
  })

  it('returns the url, method and instructions on success', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(200, {
      url: 'https://example.com/authorize',
      method: 'auto',
      instructions: 'Finish in your browser.'
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.startOAuth('anthropic', 0)).resolves.toEqual({
      ok: true,
      url: 'https://example.com/authorize',
      method: 'auto',
      instructions: 'Finish in your browser.'
    })
  })

  it('reports malformed when method is neither auto nor code', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(200, { url: 'https://x', method: 'other', instructions: 'x' })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.startOAuth('anthropic', 0)).resolves.toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('reports refused on a ProviderAuthError-shaped 400', async () => {
    const controlServer = readyServer()
    const fetch = jsonFetch(400, { name: 'ProviderAuthOauthMissing', data: { providerID: 'x' } })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.startOAuth('anthropic', 0)).resolves.toEqual({
      ok: false,
      reason: 'refused'
    })
  })
})

describe('createOpenCodeLoginService.completeOAuth', () => {
  it('POSTs /provider/{id}/oauth/callback with the method index and no code for an auto flow', async () => {
    const controlServer = readyServer('http://127.0.0.1:4096', 'hunter2')
    const fetch: OpenCodeLoginFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/callback')) return { status: 200, json: async () => true }
      return { status: 200, json: async () => ({ connected: ['opencode', 'anthropic'] }) }
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await service.completeOAuth('anthropic', 0)

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:4096/provider/anthropic/oauth/callback')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ method: 0 })
  })

  it('includes the pasted code for a code flow', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/callback')) return { status: 200, json: async () => true }
      return { status: 200, json: async () => ({ connected: ['opencode'] }) }
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await service.completeOAuth('anthropic', 0, 'ABCD-1234')

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(JSON.parse(init.body)).toEqual({ method: 0, code: 'ABCD-1234' })
  })

  it('re-reads connected after a successful callback, the same as submitApiKey', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/callback')) return { status: 200, json: async () => true }
      return { status: 200, json: async () => ({ connected: ['opencode', 'anthropic'] }) }
    })
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.completeOAuth('anthropic', 0)).resolves.toEqual({
      ok: true,
      connected: true
    })
  })

  it('bounds the wait: a callback that never resolves times out at the configured limit', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    const service = createOpenCodeLoginService({
      controlServer,
      fetch,
      completeOAuthTimeoutMs: 10
    })

    await expect(service.completeOAuth('anthropic', 0)).resolves.toEqual({
      ok: false,
      reason: 'timeout'
    })
  })

  it('is cancellable: calling cancelOAuth while blocked resolves with cancelled, not timeout', async () => {
    const controlServer = readyServer()
    // Resolves once the callback POST is actually in flight, so cancelOAuth()
    // below is not called before the async setup (ensureServer's own await)
    // has had a chance to install it — a race the fake must close, not hide.
    let notifyStarted: () => void
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const fetch: OpenCodeLoginFetch = (_url, init) => {
      notifyStarted()
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }
    const service = createOpenCodeLoginService({
      controlServer,
      fetch,
      completeOAuthTimeoutMs: 60_000
    })

    const pending = service.completeOAuth('anthropic', 0)
    await started
    service.cancelOAuth()

    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('cancelOAuth is a no-op when nothing is in flight', () => {
    const controlServer = readyServer()
    const service = createOpenCodeLoginService({ controlServer, fetch: jsonFetch(200, true) })

    expect(() => service.cancelOAuth()).not.toThrow()
  })

  it('never lets a pasted code reach a failing result, in any form, in any field', async () => {
    const SECRET_CODE = 'device-code-marker-should-never-leak'
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const service = createOpenCodeLoginService({ controlServer, fetch })

    const result = await service.completeOAuth('anthropic', 0, SECRET_CODE)

    expect(JSON.stringify(result)).not.toContain(SECRET_CODE)
  })

  it('reports unreachable for an ordinary network failure, never confusing it with a timeout', async () => {
    const controlServer = readyServer()
    const fetch: OpenCodeLoginFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const service = createOpenCodeLoginService({ controlServer, fetch })

    await expect(service.completeOAuth('anthropic', 0)).resolves.toEqual({
      ok: false,
      reason: 'unreachable'
    })
  })
})
