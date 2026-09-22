import { afterEach, describe, expect, it, vi } from 'vitest'
import { DwarfAiOpenCodePermissionPlugin } from './opencodePermissionPlugin'

const serverUrl = new URL('http://127.0.0.1:63417/')

interface Call {
  url: unknown
  init: { headers?: Record<string, string>; body?: string }
}

/** Stands in for the compiled `opencode` binary's own global `fetch` -- the
 * one import this plugin is allowed (see the module comment on why it can
 * take no injected dependency), so a global stub is the only way in. */
function stubFetch(): { calls: Call[] } {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown, init: Call['init']) => {
      calls.push({ url, init })
      return Promise.resolve(undefined)
    })
  )
  return { calls }
}

describe('DwarfAiOpenCodePermissionPlugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('authenticates with the header the app listener actually checks, not a bearer scheme', async () => {
    // hookToken.ts's tokensMatch reads HOOK_TOKEN_HEADER ('x-dwarfai-token')
    // as a raw value; an `Authorization: Bearer <token>` header would never
    // match it. Reconciled by changing this artifact rather than inventing a
    // second token scheme (#588 T3).
    const { calls } = stubFetch()
    const hooks = await DwarfAiOpenCodePermissionPlugin({ serverUrl })
    await hooks.event({ event: { type: 'permission.asked', properties: {} } })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.init.headers?.['x-dwarfai-token']).toBe('__DWARFAI_OPENCODE_PUSH_TOKEN__')
    expect(calls[0]?.init.headers?.authorization).toBeUndefined()
  })

  it('forwards the raw event and the serverUrl href, verbatim', async () => {
    const { calls } = stubFetch()
    const hooks = await DwarfAiOpenCodePermissionPlugin({ serverUrl })
    const event = {
      type: 'permission.replied',
      properties: { sessionID: 's', requestID: 'r', reply: 'once' }
    }
    await hooks.event({ event })

    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual({
      event,
      serverUrl: 'http://127.0.0.1:63417/'
    })
  })

  it('never posts an event type this app does not forward', async () => {
    const { calls } = stubFetch()
    const hooks = await DwarfAiOpenCodePermissionPlugin({ serverUrl })
    await hooks.event({ event: { type: 'message.part.delta' } })
    expect(calls).toHaveLength(0)
  })
})
