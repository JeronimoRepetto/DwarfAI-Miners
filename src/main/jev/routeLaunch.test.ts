import { describe, expect, it } from 'vitest'
import type { AgentModelCatalog, AgentProviderOption, DwarfProvider } from '../domain/types'
import { FakeJevRouter } from './fakeJevRouter'
import type { JevRouteOutcome, JevRouterPort } from './jevRouterPort'
import { createJevLaunchRouter } from './routeLaunch'

/**
 * `createJevLaunchRouter` is the main-side service behind the `jev:route`
 * IPC channel (#509): it turns one prompt into a routing SUGGESTION by
 * asking the injected `JevRouterPort`, then validates whatever it answers
 * before it is ever shown — see routeLaunch.ts's own module comment.
 *
 * These tests use `FakeJevRouter` (scripted, no network) and hand-written
 * provider/model list functions, never `vi.mock` (skills/tdd).
 */

function provider(
  overrides: { provider: DwarfProvider } & Partial<AgentProviderOption>
): AgentProviderOption {
  return { installed: true, launchable: true, ...overrides }
}

function catalog(
  overrides: { provider: DwarfProvider } & Partial<AgentModelCatalog>
): AgentModelCatalog {
  return { models: [], efforts: [], source: 'none', ...overrides }
}

const CLAUDE_PROVIDERS = [provider({ provider: 'claude' })]
const CLAUDE_CATALOGS = [catalog({ provider: 'claude', models: [{ value: 'sonnet-4.5' }] })]

function serviceWith(options: {
  router: JevRouterPort
  providers?: AgentProviderOption[]
  models?: AgentModelCatalog[]
  totalBudgetMs?: number
  now?: () => number
}) {
  return createJevLaunchRouter({
    router: options.router,
    listProviders: async () => options.providers ?? CLAUDE_PROVIDERS,
    listModels: async () => options.models ?? CLAUDE_CATALOGS,
    ...(options.totalBudgetMs === undefined ? {} : { totalBudgetMs: options.totalBudgetMs }),
    ...(options.now === undefined ? {} : { now: options.now })
  })
}

describe('createJevLaunchRouter', () => {
  it('returns a decision the router chose, validated against the launch gate', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({
      kind: 'decision',
      provider: 'claude',
      model: 'sonnet-4.5',
      effort: 'high',
      confidence: 0.91,
      usage: { inputTokens: 42 }
    })
    const service = serviceWith({ router: fake })

    const result = await service.route({ prompt: 'fix the flaky test' })

    expect(result).toEqual({
      kind: 'decision',
      provider: 'claude',
      model: 'sonnet-4.5',
      effort: 'high',
      confidence: 0.91,
      truncated: false
    })
  })

  it('asks for the live provider and model list on every call, not once at construction', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({ kind: 'fallback', reason: 'no-key' })
    fake.queueOutcome({ kind: 'fallback', reason: 'no-key' })
    let calls = 0
    const service = createJevLaunchRouter({
      router: fake,
      listProviders: async () => {
        calls += 1
        return CLAUDE_PROVIDERS
      },
      listModels: async () => CLAUDE_CATALOGS
    })

    await service.route({ prompt: 'one' })
    await service.route({ prompt: 'two' })

    expect(calls).toBe(2)
  })

  it('falls back to no-launchable-provider when nothing this machine has is launchable', async () => {
    const fake = new FakeJevRouter()
    const service = serviceWith({
      router: fake,
      providers: [provider({ provider: 'claude', launchable: false })]
    })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({ kind: 'fallback', reason: 'no-launchable-provider' })
  })

  it('falls back to budget-exceeded when the choice set is past what one request can carry', async () => {
    const fake = new FakeJevRouter()
    const manyModels = Array.from({ length: 300 }, (_, index) => ({ value: `model-${index}` }))
    const service = serviceWith({
      router: fake,
      providers: [provider({ provider: 'claude' })],
      models: [catalog({ provider: 'claude', models: manyModels })]
    })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({ kind: 'fallback', reason: 'budget-exceeded' })
  })

  it('passes a router fallback reason straight through', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({ kind: 'fallback', reason: 'rate-limited' })
    const service = serviceWith({ router: fake })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({ kind: 'fallback', reason: 'rate-limited' })
  })

  it('keeps the confidence the router reported for a low-confidence fallback', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({ kind: 'fallback', reason: 'low-confidence', confidence: 0.2 })
    const service = serviceWith({ router: fake })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({ kind: 'fallback', reason: 'low-confidence', confidence: 0.2 })
  })

  it('refuses a decision the launch gate would refuse, and falls back instead of carrying it out', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({
      kind: 'decision',
      provider: 'claude',
      effort: 'not-a-real-level',
      confidence: 0.9,
      usage: { inputTokens: 1 }
    })
    const service = serviceWith({ router: fake })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({ kind: 'fallback', reason: 'invalid-response' })
  })

  it('refuses a decision naming a provider this call cannot actually launch, belt and braces', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({
      kind: 'decision',
      provider: 'codex',
      confidence: 0.9,
      usage: { inputTokens: 1 }
    })
    const service = serviceWith({
      router: fake,
      providers: [
        provider({ provider: 'claude' }),
        provider({ provider: 'codex', launchable: false })
      ],
      models: [catalog({ provider: 'claude' }), catalog({ provider: 'codex' })]
    })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({ kind: 'fallback', reason: 'invalid-response' })
  })

  it('falls back to timeout rather than waiting past its own total budget', async () => {
    const neverResolves: JevRouterPort = {
      route: () => new Promise<JevRouteOutcome>(() => {})
    }
    const service = serviceWith({ router: neverResolves, totalBudgetMs: 5 })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({ kind: 'fallback', reason: 'timeout' })
  })

  it('never throws, even when the router itself does; unexpected errors fall back to invalid-response', async () => {
    const throwing: JevRouterPort = {
      route: () => Promise.reject(new Error('boom'))
    }
    const service = serviceWith({ router: throwing })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({ kind: 'fallback', reason: 'invalid-response' })
  })

  it('never lets the prompt text reach the result, on a decision or a fallback', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({
      kind: 'decision',
      provider: 'claude',
      confidence: 0.9,
      usage: { inputTokens: 1 }
    })
    const service = serviceWith({ router: fake })

    const result = await service.route({ prompt: 'THE-SECRET-PROMPT-TEXT' })

    expect(JSON.stringify(result)).not.toContain('THE-SECRET-PROMPT-TEXT')
  })
})
