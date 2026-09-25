import { describe, expect, it, vi } from 'vitest'
import {
  decideOpenCodeCredential,
  OPENCODE_CREDENTIAL_CHECK_TIMEOUT_MS,
  providerIdOf,
  readConnectedProviders,
  type OpenCodeConnectedFetch
} from './credentialCheck'

/**
 * Issue #597 T2. Whether an OpenCode launch's chosen model belongs to a
 * provider `GET /provider` already lists as `connected` — read over an
 * INJECTED fetch, on the same fake-fetch terms
 * `answerOpenCodePermission.test.ts` already uses, so nothing here ever
 * reaches a real network or a live `opencode serve`.
 */

function fakeFetch(handler: OpenCodeConnectedFetch): OpenCodeConnectedFetch {
  return handler
}

describe('providerIdOf', () => {
  it('reads the part before the first slash of a bare provider/model id', () => {
    expect(providerIdOf('opencode-go/xyz')).toBe('opencode-go')
  })

  it('reads the free provider id the same way', () => {
    expect(providerIdOf('opencode/grok-code')).toBe('opencode')
  })

  it('takes only the FIRST slash, leaving the rest of the model id whole', () => {
    expect(providerIdOf('anthropic/claude-3-5/preview')).toBe('anthropic')
  })

  it('is undefined for an id with no slash at all', () => {
    expect(providerIdOf('nonsense')).toBeUndefined()
  })

  it('is undefined for an empty provider ahead of the slash', () => {
    expect(providerIdOf('/xyz')).toBeUndefined()
  })

  it('is undefined for an empty model behind the slash', () => {
    expect(providerIdOf('opencode/')).toBeUndefined()
  })

  it('is undefined for an empty string', () => {
    expect(providerIdOf('')).toBeUndefined()
  })
})

describe('readConnectedProviders', () => {
  const SERVER_URL = 'http://127.0.0.1:4096'

  it('GETs /provider resolved against the server URL, with no leading path of its own', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ all: [], default: 'opencode', connected: ['opencode'] })
    })

    await readConnectedProviders(fetch, SERVER_URL, 'secret-1')

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:4096/provider')
    expect(init.method).toBe('GET')
  })

  it('resolves the same path whether or not the server URL carries a trailing slash', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ connected: [] })
    })

    await readConnectedProviders(fetch, 'http://127.0.0.1:4096/', 'secret-1')

    const [url] = fetch.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:4096/provider')
  })

  it('always sends HTTP Basic with the control server’s own username and password', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ connected: [] }) })

    await readConnectedProviders(fetch, SERVER_URL, 'hunter2')

    const [, init] = fetch.mock.calls[0]!
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from('opencode:hunter2').toString('base64')}`
    )
  })

  it('reads every connected id off a real answer shape (all, default and connected present)', async () => {
    const fetch = fakeFetch(
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          all: [{ id: 'opencode' }, { id: 'anthropic' }],
          default: 'opencode',
          connected: ['opencode', 'anthropic']
        })
      })
    )

    const result = await readConnectedProviders(fetch, SERVER_URL, 'x')

    expect(result).toEqual({ ok: true, connected: new Set(['opencode', 'anthropic']) })
  })

  it('answers unauthorized on 401, never treating it as unreachable', async () => {
    const fetch = fakeFetch(
      vi.fn().mockResolvedValue({ status: 401, json: async () => ({}), body: { cancel: vi.fn() } })
    )

    await expect(readConnectedProviders(fetch, SERVER_URL, 'wrong')).resolves.toEqual({
      ok: false,
      reason: 'unauthorized'
    })
  })

  it('releases a non-200 response body deterministically rather than leaving it unread', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const fetch = fakeFetch(
      vi.fn().mockResolvedValue({ status: 500, json: async () => ({}), body: { cancel } })
    )

    await readConnectedProviders(fetch, SERVER_URL, 'x')

    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('reports unreachable for any other non-200 status', async () => {
    const fetch = fakeFetch(vi.fn().mockResolvedValue({ status: 500, json: async () => ({}) }))

    await expect(readConnectedProviders(fetch, SERVER_URL, 'x')).resolves.toEqual({
      ok: false,
      reason: 'unreachable'
    })
  })

  it('reports unreachable when the request never reaches a server at all', async () => {
    const fetch = fakeFetch(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(readConnectedProviders(fetch, SERVER_URL, 'x')).resolves.toEqual({
      ok: false,
      reason: 'unreachable'
    })
  })

  it('tells a timeout apart from an ordinary connection failure', async () => {
    const timeoutError = new DOMException('The operation was aborted.', 'TimeoutError')
    const fetch = fakeFetch(vi.fn().mockRejectedValue(timeoutError))

    await expect(readConnectedProviders(fetch, SERVER_URL, 'x')).resolves.toEqual({
      ok: false,
      reason: 'timeout'
    })
  })

  it('bounds the wait with a documented timeout, passed as the request’s own abort signal', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ connected: [] }) })

    await readConnectedProviders(fetch, SERVER_URL, 'x')

    const [, init] = fetch.mock.calls[0]!
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(OPENCODE_CREDENTIAL_CHECK_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('reports malformed when the body cannot be parsed as JSON', async () => {
    const fetch = fakeFetch(
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => {
          throw new Error('not json')
        }
      })
    )

    await expect(readConnectedProviders(fetch, SERVER_URL, 'x')).resolves.toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('reports malformed when the body has no connected array', async () => {
    const fetch = fakeFetch(vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }))

    await expect(readConnectedProviders(fetch, SERVER_URL, 'x')).resolves.toEqual({
      ok: false,
      reason: 'malformed'
    })
  })

  it('reports malformed when connected holds something other than strings', async () => {
    const fetch = fakeFetch(
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ connected: [1, 2] }) })
    )

    await expect(readConnectedProviders(fetch, SERVER_URL, 'x')).resolves.toEqual({
      ok: false,
      reason: 'malformed'
    })
  })
})

describe('decideOpenCodeCredential', () => {
  it('is ready when no model was chosen — nothing to check', () => {
    expect(decideOpenCodeCredential(undefined, new Set())).toEqual({ kind: 'ready' })
  })

  it('is ready when the model id carries no readable provider', () => {
    expect(decideOpenCodeCredential('nonsense', new Set(['opencode']))).toEqual({ kind: 'ready' })
  })

  it('is ready when the chosen provider is connected', () => {
    expect(
      decideOpenCodeCredential('anthropic/claude-3-5', new Set(['opencode', 'anthropic']))
    ).toEqual({
      kind: 'ready'
    })
  })

  it('is ready for the free opencode/* tier, whose provider T1 measured as always connected', () => {
    expect(decideOpenCodeCredential('opencode/grok-code', new Set(['opencode']))).toEqual({
      kind: 'ready'
    })
  })

  it('reports credential-missing naming the provider and the model, when the provider is absent', () => {
    expect(decideOpenCodeCredential('anthropic/claude-3-5', new Set(['opencode']))).toEqual({
      kind: 'credential-missing',
      providerId: 'anthropic',
      model: 'anthropic/claude-3-5'
    })
  })

  it('reports credential-missing against an empty connected set', () => {
    expect(decideOpenCodeCredential('anthropic/claude-3-5', new Set())).toEqual({
      kind: 'credential-missing',
      providerId: 'anthropic',
      model: 'anthropic/claude-3-5'
    })
  })
})
