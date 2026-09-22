import { describe, expect, it, vi } from 'vitest'
import {
  createOpenCodePermissionAnswerPort,
  OPENCODE_PERMISSION_POST_TIMEOUT_MS,
  type OpenCodePermissionFetch
} from './answerOpenCodePermission'

/**
 * Issue #588 T5. The HTTP half of answering an OpenCode permission dialog —
 * docs/opencode-format.md Row 15/16's own measured contract, over an
 * INJECTED fetch (mirroring delegationLink.ts's own DelegationFetch), so
 * nothing here ever reaches a real network or a live CLI.
 */

function fakeFetch(
  handler: OpenCodePermissionFetch = vi.fn().mockResolvedValue({
    status: 200,
    json: async () => true
  })
): OpenCodePermissionFetch {
  return handler
}

const REQUEST = {
  serverUrl: 'http://127.0.0.1:63417/',
  sessionId: 'ses_1',
  requestId: 'per_1',
  response: 'once' as const
}

describe('createOpenCodePermissionAnswerPort', () => {
  it('POSTs the measured endpoint with the decision as the whole body', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => true })
    const port = createOpenCodePermissionAnswerPort(fetch, {})

    await expect(port(REQUEST)).resolves.toEqual({ answered: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:63417/session/ses_1/permissions/per_1')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ response: 'once' }))
    expect(init.headers['content-type']).toBe('application/json')
  })

  it('sends no Authorization header when no password is configured, matching the server’s own gate', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => true })
    const port = createOpenCodePermissionAnswerPort(fetch, {})

    await port(REQUEST)
    const [, init] = fetch.mock.calls[0]!
    expect(init.headers.authorization).toBeUndefined()
  })

  it('sends HTTP Basic from OPENCODE_SERVER_USERNAME/PASSWORD when a password is set (unverified live, #588 T5)', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => true })
    const port = createOpenCodePermissionAnswerPort(fetch, {
      OPENCODE_SERVER_USERNAME: 'jero',
      OPENCODE_SERVER_PASSWORD: 'hunter2'
    })

    await port(REQUEST)
    const [, init] = fetch.mock.calls[0]!
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from('jero:hunter2').toString('base64')}`
    )
  })

  it('defaults the Basic username to "opencode", the measured default, when only a password is set', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => true })
    const port = createOpenCodePermissionAnswerPort(fetch, { OPENCODE_SERVER_PASSWORD: 'x' })

    await port(REQUEST)
    const [, init] = fetch.mock.calls[0]!
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('opencode:x').toString('base64')}`)
  })

  it('treats a blank password the same as an unset one — no header sent', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => true })
    const port = createOpenCodePermissionAnswerPort(fetch, { OPENCODE_SERVER_PASSWORD: '' })

    await port(REQUEST)
    const [, init] = fetch.mock.calls[0]!
    expect(init.headers.authorization).toBeUndefined()
  })

  it('answers true only for exactly the measured success shape: 200 and the JSON literal true', async () => {
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(vi.fn().mockResolvedValue({ status: 200, json: async () => true })),
      {}
    )
    await expect(port(REQUEST)).resolves.toEqual({ answered: true })
  })

  it('refuses a 200 whose body is not literally true, rather than trusting the status alone', async () => {
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(vi.fn().mockResolvedValue({ status: 200, json: async () => false })),
      {}
    )
    await expect(port(REQUEST)).resolves.toEqual({ answered: false, reason: 'refused' })
  })

  it('refuses a 200 whose body cannot even be parsed as JSON', async () => {
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(
        vi.fn().mockResolvedValue({
          status: 200,
          json: async () => {
            throw new Error('not json')
          }
        })
      ),
      {}
    )
    await expect(port(REQUEST)).resolves.toEqual({ answered: false, reason: 'refused' })
  })

  it('names a 401 unauthorized rather than folding it into the generic refusal', async () => {
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(vi.fn().mockResolvedValue({ status: 401, json: async () => ({}) })),
      {}
    )
    await expect(port(REQUEST)).resolves.toEqual({ answered: false, reason: 'unauthorized' })
  })

  /**
   * F3 (review finding, #588 T5): OpenCode's own PermissionNotFound — the
   * person answered at their own terminal, or another panel click, before
   * this POST landed — was folded into the generic 'refused' reason, whose
   * sentence ("did not accept that decision") invites a re-click. The prompt
   * is not refusable any more because it is gone, which is exactly what
   * 'not-found' lets runtime.ts's openCodePermissionRefusal say honestly (the
   * existing PROMPT_NO_LONGER_OPEN sentence — see runtime.test.ts's own pin).
   */
  it('names a 404 not-found rather than folding it into the generic refusal (F3)', async () => {
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(vi.fn().mockResolvedValue({ status: 404, json: async () => ({}) })),
      {}
    )
    await expect(port(REQUEST)).resolves.toEqual({ answered: false, reason: 'not-found' })
  })

  it('refuses any other non-200 status without reading the body', async () => {
    const json = vi.fn()
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(vi.fn().mockResolvedValue({ status: 500, json })),
      {}
    )

    await expect(port(REQUEST)).resolves.toEqual({ answered: false, reason: 'refused' })
    expect(json).not.toHaveBeenCalled()
  })

  /**
   * F4 (review finding, #588 T5): a non-200 returned without reading OR
   * cancelling `response.body`. With undici the connection stays checked out
   * until GC reclaims it — bounded in practice (one request per click), but
   * `response.body?.cancel()` makes releasing it deterministic. Cancelling is
   * not reading: `json` must stay uncalled, exactly as the test above pins.
   */
  it('cancels the response body on a non-200 status, rather than leaving it unread (F4)', async () => {
    const json = vi.fn()
    const cancel = vi.fn().mockResolvedValue(undefined)
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(vi.fn().mockResolvedValue({ status: 500, json, body: { cancel } })),
      {}
    )

    await expect(port(REQUEST)).resolves.toEqual({ answered: false, reason: 'refused' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(json).not.toHaveBeenCalled()
  })

  it('cancels the response body on a 404 too, the same as any other non-200 (F4)', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(
        vi.fn().mockResolvedValue({ status: 404, json: async () => ({}), body: { cancel } })
      ),
      {}
    )

    await port(REQUEST)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('never cancels the body on a 200 — there is nothing to release, only to read', async () => {
    const cancel = vi.fn()
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(
        vi.fn().mockResolvedValue({ status: 200, json: async () => true, body: { cancel } })
      ),
      {}
    )

    await port(REQUEST)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('reports unreachable when the request never reaches a server at all — the TUI closed, say', async () => {
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))),
      {}
    )
    await expect(port(REQUEST)).resolves.toEqual({ answered: false, reason: 'unreachable' })
  })

  it('tells a timeout apart from an ordinary connection failure', async () => {
    const timeoutError = new DOMException('The operation was aborted.', 'TimeoutError')
    const port = createOpenCodePermissionAnswerPort(
      fakeFetch(vi.fn().mockRejectedValue(timeoutError)),
      {}
    )

    await expect(port(REQUEST)).resolves.toEqual({ answered: false, reason: 'timeout' })
  })

  it('bounds the wait with the documented timeout, passed as the request’s own abort signal', async () => {
    const fetch = vi.fn().mockResolvedValue({ status: 200, json: async () => true })
    const port = createOpenCodePermissionAnswerPort(fetch, {})

    await port(REQUEST)
    const [, init] = fetch.mock.calls[0]!
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(OPENCODE_PERMISSION_POST_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
