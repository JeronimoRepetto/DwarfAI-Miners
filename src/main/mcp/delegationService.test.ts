import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchResult, DwarfProvider, TurnOutcome } from '../domain/types'
import { NOT_LAUNCHABLE } from '../domain/launchProviders'
import {
  MAX_DELEGATION_CONTEXT_CHARS,
  MAX_DELEGATION_TASK_CHARS,
  resultRoute,
  type DelegationRouting
} from './delegationProtocol'
import { DelegationService, type DelegationServiceOptions } from './delegationService'
import {
  DELEGATE_ROUTE,
  DELEGATION_TOKEN_HEADER,
  MAX_DELEGATION_BODY_BYTES
} from './delegationServerProtocol'

/**
 * The delegation service (#511 T3): a loopback listener in `HookServer`'s own
 * shape, in front of the ticket/token/concurrency registries and the routing
 * mapper already proven in isolation (`delegationTokens.ts`,
 * `delegationTickets.ts`, `delegationConcurrency.ts`, `delegationRouting.ts`).
 * Real sockets here on purpose (the same choice `hookServer.test.ts` makes)
 * — everything BENEATH the HTTP layer is a hand-written fake, so this is the
 * one place the whole wire contract is proven end to end without a real Jev
 * call or a real agent process.
 *
 * `launch` is the one port this service asks to start a delegated child —
 * `AgentRuntime.launchAgent` bound in production, so a delegated child is
 * bookkept by the app's ONE real launch registry exactly like any other
 * launch (board visibility, kick/end support), and its own TurnOutcome
 * arrives by callback through `hooks.onConcluded`, never a poll.
 */

const ROUTING: DelegationRouting = { provider: 'claude', model: 'sonnet' }
const CONCLUDED: TurnOutcome = { kind: 'concluded', text: 'done', endedAt: 1 }

function decisionResult(provider: DwarfProvider = 'claude') {
  return {
    kind: 'decision' as const,
    provider,
    model: 'sonnet',
    confidence: 0.9,
    truncated: false,
    tier: 'balanced' as const,
    parts: {
      provider: { value: provider, confidence: 0.9, applied: 'answered' as const },
      tier: { value: 'balanced' as const, confidence: 0.9, applied: 'answered' as const },
      trivial: { value: false, probability: 0.1 },
      largeContext: { value: false, probability: 0.1 }
    }
  }
}

describe('DelegationService', () => {
  let service: DelegationService
  let launch: ReturnType<typeof vi.fn<DelegationServiceOptions['launch']>>
  let route: ReturnType<typeof vi.fn<DelegationServiceOptions['route']>>
  let keyConfigured: ReturnType<typeof vi.fn<DelegationServiceOptions['keyConfigured']>>
  let delegationAllowed: ReturnType<typeof vi.fn<DelegationServiceOptions['delegationAllowed']>>
  let onConcludedByMine: Map<string, (outcome: TurnOutcome) => void>

  function options(overrides: Partial<DelegationServiceOptions> = {}): DelegationServiceOptions {
    return {
      port: 0,
      launch,
      route,
      keyConfigured,
      delegationAllowed,
      ...overrides
    }
  }

  function freshFixtures(): void {
    onConcludedByMine = new Map()
    launch = vi.fn<DelegationServiceOptions['launch']>(
      async (request, hooks): Promise<AgentLaunchResult> => {
        onConcludedByMine.set(request.mineId, hooks.onConcluded)
        return { launched: true, provider: 'claude' }
      }
    )
    route = vi.fn<DelegationServiceOptions['route']>(async () => decisionResult())
    keyConfigured = vi.fn<DelegationServiceOptions['keyConfigured']>(() => true)
    delegationAllowed = vi.fn<DelegationServiceOptions['delegationAllowed']>(async () => true)
  }
  freshFixtures()

  afterEach(async () => {
    await service?.stop()
    freshFixtures()
  })

  function url(path: string): string {
    return `http://127.0.0.1:${service.port}${path}`
  }

  async function post(
    body: unknown,
    init: { token?: string | null; path?: string } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (init.token !== null) headers[DELEGATION_TOKEN_HEADER] = init.token ?? 'unset'
    return fetch(url(init.path ?? DELEGATE_ROUTE), {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  }

  async function get(path: string, token: string | null = 'unset'): Promise<Response> {
    const headers: Record<string, string> = {}
    if (token !== null) headers[DELEGATION_TOKEN_HEADER] = token
    return fetch(url(path), { headers })
  }

  it('binds loopback and reports the port it actually got', async () => {
    service = new DelegationService(options())
    await service.start()
    expect(service.port).toBeGreaterThan(0)
  })

  it('issueLaunchToken answers an endpoint naming the bound port, and a token', async () => {
    service = new DelegationService(options({ generateToken: () => 'tok-1' }))
    await service.start()
    const issued = service.issueLaunchToken({ mineId: 'mine:a' })
    expect(issued).toEqual({ endpoint: `http://127.0.0.1:${service.port}`, token: 'tok-1' })
  })

  it('answers 404 for an unknown route, before any token is even checked', async () => {
    service = new DelegationService(options())
    await service.start()
    const response = await fetch(url('/nope'), { method: 'POST' })
    expect(response.status).toBe(404)
  })

  it('answers 404 for the delegate route on the wrong method', async () => {
    service = new DelegationService(options())
    await service.start()
    const response = await fetch(url(DELEGATE_ROUTE), { method: 'GET' })
    expect(response.status).toBe(404)
  })

  it('answers 401 for /delegate with a token nobody issued', async () => {
    service = new DelegationService(options())
    await service.start()
    const response = await post({ task: 'x' }, { token: 'never-issued' })
    expect(response.status).toBe(401)
    expect(launch).not.toHaveBeenCalled()
  })

  it('answers 401 for /result with a token nobody issued', async () => {
    service = new DelegationService(options())
    await service.start()
    const response = await get(resultRoute('anything'), 'never-issued')
    expect(response.status).toBe(401)
  })

  it('accepts a well-formed delegation: 202 with a ticket and the routing decision', async () => {
    service = new DelegationService(options({ generateTicketId: () => 't-1' }))
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const response = await post({ task: 'find the bug' }, { token })

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ ticket: 't-1', routing: ROUTING })
    expect(launch).toHaveBeenCalledWith(
      { mineId: 'mine:a', provider: 'claude', prompt: 'find the bug', model: 'sonnet' },
      expect.objectContaining({ onConcluded: expect.any(Function) })
    )
  })

  it('combines context and task into the child’s own prompt', async () => {
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    await post({ task: 'find the bug', context: 'it started after #511' }, { token })

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'it started after #511\n\nfind the bug' }),
      expect.anything()
    )
  })

  it('GET /result answers pending before the child has concluded', async () => {
    service = new DelegationService(options({ generateTicketId: () => 't-1' }))
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })
    await post({ task: 'x' }, { token })

    const response = await get(resultRoute('t-1'), token)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'pending', routing: ROUTING })
  })

  it('GET /result answers done once the launch’s own onConcluded fires', async () => {
    service = new DelegationService(options({ generateTicketId: () => 't-1' }))
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })
    await post({ task: 'x' }, { token })

    onConcludedByMine.get('mine:a')?.(CONCLUDED)

    const response = await get(resultRoute('t-1'), token)
    expect(await response.json()).toEqual({ status: 'done', outcome: CONCLUDED })
  })

  it('GET /result answers done with a synthetic interrupted outcome when the child never reports one', async () => {
    service = new DelegationService(options({ generateTicketId: () => 't-1' }))
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })
    await post({ task: 'x' }, { token })

    onConcludedByMine.get('mine:a')?.({ kind: 'interrupted', endedAt: 5 })

    const response = await get(resultRoute('t-1'), token)
    expect(await response.json()).toEqual({
      status: 'done',
      outcome: { kind: 'interrupted', endedAt: 5 }
    })
  })

  it('GET /result for an unknown ticket answers a typed unknown-ticket failure, not 404', async () => {
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const response = await get(resultRoute('never-existed'), token)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; failure: { kind: string } }
    expect(body.status).toBe('failed')
    expect(body.failure.kind).toBe('unknown-ticket')
  })

  it('a ticket presented with a DIFFERENT parent’s token reads as unknown-ticket too', async () => {
    service = new DelegationService(options({ generateTicketId: () => 't-1' }))
    await service.start()
    const first = service.issueLaunchToken({ mineId: 'mine:a' })
    const second = service.issueLaunchToken({ mineId: 'mine:b' })
    await post({ task: 'x' }, { token: first.token })

    const response = await get(resultRoute('t-1'), second.token)
    const body = (await response.json()) as { status: string; failure: { kind: string } }
    expect(body.status).toBe('failed')
    expect(body.failure.kind).toBe('unknown-ticket')
  })

  it('GET /result with a malformed %-escape in the ticket answers unknown-ticket, not a 500 (#511 LOW-10)', async () => {
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    // A lone `%` is not a valid escape sequence — `decodeURIComponent` throws
    // on it rather than returning undefined, and the raw URL is used here
    // (never `resultRoute`, which would itself percent-encode it away).
    const response = await get('/result/%', token)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; failure: { kind: string } }
    expect(body.status).toBe('failed')
    expect(body.failure.kind).toBe('unknown-ticket')
  })

  it('revoke makes a previously issued token stop working', async () => {
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })
    service.revoke(token)

    const response = await post({ task: 'x' }, { token })
    expect(response.status).toBe(401)
  })

  it('answers 400 for a malformed body', async () => {
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const response = await post('not json', { token })
    expect(response.status).toBe(400)
    expect(launch).not.toHaveBeenCalled()
  })

  it('answers 400 for a body missing task', async () => {
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const response = await post({}, { token })
    expect(response.status).toBe(400)
  })

  it('accepts a max-length, non-ASCII task and context (#511 LOW-9)', async () => {
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    // '€' (U+20AC) is a realistic 3-byte-UTF-8 character — every schema-valid
    // request the zod schema in jevMcpServerCore.ts admits must still fit
    // under MAX_DELEGATION_BODY_BYTES once wrapped in JSON.
    const response = await post(
      {
        task: '€'.repeat(MAX_DELEGATION_TASK_CHARS),
        context: '€'.repeat(MAX_DELEGATION_CONTEXT_CHARS)
      },
      { token }
    )
    expect(response.status).toBe(202)
  })

  it('accepts a max-length task and context made ENTIRELY of unescaped control characters, the true worst case (#511 LOW-9)', async () => {
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    // U+0001 has no short JSON escape (unlike \n, \t, ", \\), so
    // JSON.stringify emits `\u0001` — 6 ASCII bytes for ONE UTF-16 code unit,
    // worse than any single character's raw UTF-8 encoding (max 4 bytes).
    // Neither the zod schema nor `parseDelegateRequestBody` restricts
    // content, so a schema-valid task/context CAN be built entirely of these.
    const response = await post(
      {
        task: '\u0001'.repeat(MAX_DELEGATION_TASK_CHARS),
        context: '\u0001'.repeat(MAX_DELEGATION_CONTEXT_CHARS)
      },
      { token }
    )
    expect(response.status).toBe(202)
  })

  it('answers 413 for an oversized body and never launches anything (#511 LOW-6)', async () => {
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    // Deterministic, not "413 or a transport error" (`hookServer.test.ts`'s
    // own accepted shape for the identical race): `readBody` must not reset
    // the connection while the 413 is still in flight. A body only barely
    // over the cap arrives in a single `data` event on loopback and would
    // pass even against the bug this pins — 20x reliably arrives across
    // several, which is what actually exercised the reset in practice.
    const response = await post({ task: 'x'.repeat(MAX_DELEGATION_BODY_BYTES * 20) }, { token })
    expect(response.status).toBe(413)
    expect(launch).not.toHaveBeenCalled()
  })

  it('refuses with disabled when no TypeSafe key is configured, re-checked live rather than at token-issue time', async () => {
    keyConfigured.mockReturnValue(false)
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const response = await post({ task: 'x' }, { token })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { failure: { kind: string } }
    expect(body.failure.kind).toBe('disabled')
    expect(launch).not.toHaveBeenCalled()
  })

  it('refuses with disabled when the delegation preference is off, re-checked live', async () => {
    delegationAllowed.mockResolvedValue(false)
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const response = await post({ task: 'x' }, { token })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { failure: { kind: string } }
    expect(body.failure.kind).toBe('disabled')
    expect(launch).not.toHaveBeenCalled()
  })

  it('refuses with jev-unreachable when routing falls back with no configured default', async () => {
    route.mockResolvedValue({ kind: 'fallback', reason: 'unreachable' })
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const response = await post({ task: 'x' }, { token })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { failure: { kind: string } }
    expect(body.failure.kind).toBe('jev-unreachable')
    expect(launch).not.toHaveBeenCalled()
  })

  it('refuses with provider-not-launchable when the routed provider is structurally not launchable', async () => {
    launch.mockResolvedValue({ launched: false, provider: 'opencode', error: NOT_LAUNCHABLE })
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const response = await post({ task: 'x' }, { token })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { failure: { kind: string } }
    expect(body.failure.kind).toBe('provider-not-launchable')
  })

  it('refuses with launch-failed when the launch attempt itself fails for any other reason', async () => {
    launch.mockResolvedValue({ launched: false, provider: 'claude', error: 'not installed' })
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const response = await post({ task: 'x' }, { token })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { failure: { kind: string } }
    expect(body.failure.kind).toBe('launch-failed')
  })

  it('enforces the per-parent concurrency cap', async () => {
    service = new DelegationService(options({ limits: { perParent: 1, global: 10 } }))
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const first = await post({ task: 'x' }, { token })
    expect(first.status).toBe(202)
    const second = await post({ task: 'y' }, { token })
    expect(second.status).toBe(400)
    const body = (await second.json()) as { failure: { kind: string } }
    expect(body.failure.kind).toBe('concurrency-limit')
  })

  it('enforces the global concurrency cap across different parents', async () => {
    service = new DelegationService(options({ limits: { perParent: 5, global: 1 } }))
    await service.start()
    const a = service.issueLaunchToken({ mineId: 'mine:a' })
    const b = service.issueLaunchToken({ mineId: 'mine:b' })

    const first = await post({ task: 'x' }, { token: a.token })
    expect(first.status).toBe(202)
    const second = await post({ task: 'y' }, { token: b.token })
    expect(second.status).toBe(400)
  })

  it('releases the concurrency slot once the ticket settles, allowing a further delegation', async () => {
    service = new DelegationService(options({ limits: { perParent: 1, global: 10 } }))
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    await post({ task: 'x' }, { token })
    onConcludedByMine.get('mine:a')?.(CONCLUDED)

    const second = await post({ task: 'y' }, { token })
    expect(second.status).toBe(202)
  })

  it('answers a typed failure and releases the slot when the router itself throws (#511 LOW-3)', async () => {
    route.mockRejectedValueOnce(new Error('jev crashed'))
    service = new DelegationService(options({ limits: { perParent: 1, global: 10 } }))
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    const first = await post({ task: 'x' }, { token })
    expect(first.status).toBe(400)
    const body = (await first.json()) as { failure: { kind: string; detail: string } }
    expect(body.failure.kind).toBe('launch-failed')
    expect(body.failure.detail).toContain('jev crashed')
    expect(launch).not.toHaveBeenCalled()

    // The slot a throwing router leaked used to make every FURTHER
    // delegation for this same token refuse with concurrency-limit forever,
    // even though nothing was actually running.
    const second = await post({ task: 'y' }, { token })
    expect(second.status).toBe(202)
  })

  it('releases the concurrency slot when the delegation is refused before any ticket is created', async () => {
    route.mockResolvedValue({ kind: 'fallback', reason: 'unreachable' })
    service = new DelegationService(options({ limits: { perParent: 1, global: 10 } }))
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    await post({ task: 'x' }, { token })
    route.mockResolvedValue(decisionResult())
    const second = await post({ task: 'y' }, { token })
    expect(second.status).toBe(202)
  })

  it('never sets routedByJev on the request handed to launch — depth 1 (#511 LOW-7)', async () => {
    service = new DelegationService(options())
    await service.start()
    const { token } = service.issueLaunchToken({ mineId: 'mine:a' })

    await post({ task: 'find the bug' }, { token })

    const request = launch.mock.calls[0]?.[0]
    expect(request).toBeDefined()
    expect(Object.hasOwn(request as object, 'routedByJev')).toBe(false)
  })

  it('stop() closes the listener, so a further request cannot connect', async () => {
    service = new DelegationService(options())
    await service.start()
    const boundUrl = url(DELEGATE_ROUTE)
    await service.stop()
    await expect(fetch(boundUrl, { method: 'POST' })).rejects.toThrow()
  })

  it('is safe to start twice and stop twice', async () => {
    service = new DelegationService(options())
    await service.start()
    const port = service.port
    await service.start()
    expect(service.port).toBe(port)
    await service.stop()
    await service.stop()
  })
})
