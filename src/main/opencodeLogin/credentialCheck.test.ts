import { describe, expect, it, vi } from 'vitest'
import {
  decideOpenCodeCredential,
  OPENCODE_CREDENTIAL_CHECK_TIMEOUT_MS,
  providerIdOf,
  readConfiguredModel,
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

/**
 * Issue #597 T3b. `GET /config`'s own measured shape (OpenCode 1.18.32,
 * `GET /doc`): `config.get` takes an optional `directory` query parameter,
 * live-verified to resolve a project's own `opencode.json` over the global
 * default for that folder. Only `model` is ever read off the body — the rest,
 * which can carry `provider.*.options.apiKey` (also confirmed against the
 * live OpenAPI schema), is discarded unread on every path below.
 */
describe('readConfiguredModel', () => {
  const SERVER_URL = 'http://127.0.0.1:4096'
  const DIRECTORY = 'C:\\mines\\dwarf-pit'

  function fakeFetch(handler: OpenCodeConnectedFetch): OpenCodeConnectedFetch {
    return handler
  }

  it('GETs /config resolved for the launch folder as its own directory query parameter', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) })

    await readConfiguredModel(fetch, SERVER_URL, 'secret-1', DIRECTORY)

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('http://127.0.0.1:4096/config')
    expect(parsed.searchParams.get('directory')).toBe(DIRECTORY)
    expect(init.method).toBe('GET')
  })

  it('sends the same HTTP Basic auth readConnectedProviders does', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) })

    await readConfiguredModel(fetch, SERVER_URL, 'hunter2', DIRECTORY)

    const [, init] = fetch.mock.calls[0]!
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from('opencode:hunter2').toString('base64')}`
    )
  })

  it('reads the configured model off a real answer shape (measured live, OpenCode 1.18.32)', async () => {
    const fetch = fakeFetch(
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ model: 'anthropic/claude-sonnet-5' })
      })
    )

    await expect(readConfiguredModel(fetch, SERVER_URL, 'x', DIRECTORY)).resolves.toEqual({
      ok: true,
      model: 'anthropic/claude-sonnet-5'
    })
  })

  it('is ok with an undefined model when the resolved config carries none — never a failure', async () => {
    const fetch = fakeFetch(vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }))

    await expect(readConfiguredModel(fetch, SERVER_URL, 'x', DIRECTORY)).resolves.toEqual({
      ok: true,
      model: undefined
    })
  })

  it('ignores a non-string model rather than failing — the same "nothing to check" reading an absent one gets', async () => {
    const fetch = fakeFetch(
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ model: 42 }) })
    )

    await expect(readConfiguredModel(fetch, SERVER_URL, 'x', DIRECTORY)).resolves.toEqual({
      ok: true,
      model: undefined
    })
  })

  it('never reads anything past `model` — a fake secret elsewhere in the body never reaches the result', async () => {
    const fetch = fakeFetch(
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          model: 'anthropic/claude-sonnet-5',
          provider: { anthropic: { options: { apiKey: 'sk-FAKESECRET-must-never-leak' } } }
        })
      })
    )

    const result = await readConfiguredModel(fetch, SERVER_URL, 'x', DIRECTORY)

    expect(result).toEqual({ ok: true, model: 'anthropic/claude-sonnet-5' })
    expect(JSON.stringify(result)).not.toContain('FAKESECRET')
  })

  it('answers unauthorized on 401, never treating it as unreachable', async () => {
    const fetch = fakeFetch(
      vi.fn().mockResolvedValue({ status: 401, json: async () => ({}), body: { cancel: vi.fn() } })
    )

    await expect(readConfiguredModel(fetch, SERVER_URL, 'wrong', DIRECTORY)).resolves.toEqual({
      ok: false,
      reason: 'unauthorized'
    })
  })

  it('releases a non-200 response body deterministically rather than leaving it unread', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const fetch = fakeFetch(
      vi.fn().mockResolvedValue({ status: 500, json: async () => ({}), body: { cancel } })
    )

    await readConfiguredModel(fetch, SERVER_URL, 'x', DIRECTORY)

    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('reports unreachable for any other non-200 status', async () => {
    const fetch = fakeFetch(vi.fn().mockResolvedValue({ status: 500, json: async () => ({}) }))

    await expect(readConfiguredModel(fetch, SERVER_URL, 'x', DIRECTORY)).resolves.toEqual({
      ok: false,
      reason: 'unreachable'
    })
  })

  it('reports unreachable when the request never reaches a server at all', async () => {
    const fetch = fakeFetch(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(readConfiguredModel(fetch, SERVER_URL, 'x', DIRECTORY)).resolves.toEqual({
      ok: false,
      reason: 'unreachable'
    })
  })

  it('tells a timeout apart from an ordinary connection failure', async () => {
    const timeoutError = new DOMException('The operation was aborted.', 'TimeoutError')
    const fetch = fakeFetch(vi.fn().mockRejectedValue(timeoutError))

    await expect(readConfiguredModel(fetch, SERVER_URL, 'x', DIRECTORY)).resolves.toEqual({
      ok: false,
      reason: 'timeout'
    })
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

    await expect(readConfiguredModel(fetch, SERVER_URL, 'x', DIRECTORY)).resolves.toEqual({
      ok: false,
      reason: 'malformed'
    })
  })
})
