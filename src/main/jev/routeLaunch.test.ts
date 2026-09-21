import { describe, expect, it } from 'vitest'
import type {
  AgentModelCatalog,
  AgentProviderOption,
  DwarfProvider,
  JevPreferences
} from '../domain/types'
import type { OpenCodeCatalogueModel } from '../providers/opencode/models'
import { FakeJevRouter } from './fakeJevRouter'
import type { JevRouteAnswers, JevRouteOutcome, JevRouterPort } from './jevRouterPort'
import { createJevLaunchRouter } from './routeLaunch'

/**
 * `createJevLaunchRouter` is the main-side service behind the `jev:route`
 * IPC channel (#509): it turns one prompt into a routing SUGGESTION by
 * asking the injected `JevRouterPort` for Jev's own answers, then
 * `routeDecision.ts`'s `decideLaunch` for what they mean, before either is
 * ever shown — see routeLaunch.ts's own module comment.
 *
 * These tests use `FakeJevRouter` (scripted, no network), hand-written
 * provider/model list functions, and the REAL `MODEL_CAPABILITIES` table
 * `decideLaunch` reads through this service (never `vi.mock` — skills/tdd):
 * fixture model ids below are therefore REAL capability-table ids (`sonnet`,
 * `gpt-5.6-sol`), not the placeholder `sonnet-4.5` the old v1 suite used.
 *
 * request v2 (jev-routing-profiles T3) REMOVES two v1 tests outright rather
 * than amending them, because the scenario each pinned no longer exists:
 * - "falls back to budget-exceeded when the choice set is past what one
 *   request can carry": the request no longer asks one Choice per model, so
 *   a 300-model catalogue no longer inflates it — see routeRequest.test.ts's
 *   own note.
 * - "refuses a decision the launch gate would refuse": the port's answer no
 *   longer carries a raw effort STRING a launch could refuse outright — it
 *   carries a `{ score }`, and `decideLaunch` only ever derives an effort
 *   from `PROVIDER_EFFORT_LEVELS`, so this exact shape of failure cannot be
 *   constructed at this boundary any more.
 * The "belt and braces" test for a router-named provider this call cannot
 * launch is REPLACED, not removed — see its own comment below for the
 * changed assertion.
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

function answers(overrides: Partial<JevRouteAnswers> = {}): JevRouteAnswers {
  return {
    kind: 'answers',
    provider: { choice: 'claude', confidence: 0.91 },
    tier: { choice: 'balanced', confidence: 0.91 },
    trivial: { probability: 0.05 },
    largeContext: { probability: 0.05 },
    effort: { score: 1.5 },
    usage: { inputTokens: 42 },
    ...overrides
  }
}

const CLAUDE_PROVIDERS = [provider({ provider: 'claude' })]
// 'sonnet' is a real MODEL_CAPABILITIES.claude id (see capabilities/claude.ts) — balanced tier, medium cost.
const CLAUDE_CATALOGS = [catalog({ provider: 'claude', models: [{ value: 'sonnet' }] })]
const DEFAULT_PREFERENCES: JevPreferences = { profile: 'balanced', default: {} }

// AMENDED for #547 (added): `readOpenCodeCatalogue`, optional — every
// existing call below that omits it keeps reading `[]` (routeLaunch.ts's own
// default), the same "nothing derived, nothing offered" answer an
// unavailable catalogue already produces, so no other test here changes.
function serviceWith(options: {
  router: JevRouterPort
  providers?: AgentProviderOption[]
  models?: AgentModelCatalog[]
  preferences?: JevPreferences
  totalBudgetMs?: number
  now?: () => number
  debugLog?: (line: string) => void
  readOpenCodeCatalogue?: () => Promise<readonly OpenCodeCatalogueModel[]>
}) {
  return createJevLaunchRouter({
    router: options.router,
    listProviders: async () => options.providers ?? CLAUDE_PROVIDERS,
    listModels: async () => options.models ?? CLAUDE_CATALOGS,
    readPreferences: async () => options.preferences ?? DEFAULT_PREFERENCES,
    ...(options.totalBudgetMs === undefined ? {} : { totalBudgetMs: options.totalBudgetMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.debugLog === undefined ? {} : { debugLog: options.debugLog }),
    ...(options.readOpenCodeCatalogue === undefined
      ? {}
      : { readOpenCodeCatalogue: options.readOpenCodeCatalogue })
  })
}

describe('createJevLaunchRouter', () => {
  it("returns decideLaunch's own decision, with truncated attached", async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(answers())
    const service = serviceWith({ router: fake })

    const result = await service.route({ prompt: 'fix the flaky test' })

    expect(result).toEqual({
      kind: 'decision',
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
      confidence: 0.91,
      truncated: false,
      tier: 'balanced',
      parts: {
        provider: { value: 'claude', confidence: 0.91, applied: 'answered' },
        tier: { value: 'balanced', confidence: 0.91, applied: 'answered' },
        trivial: { value: false, probability: 0.05 },
        largeContext: { value: false, probability: 0.05 }
      }
    })
  })

  it('asks for the live provider list, model list and preferences on every call, not once at construction', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({ kind: 'fallback', reason: 'no-key' })
    fake.queueOutcome({ kind: 'fallback', reason: 'no-key' })
    let providerCalls = 0
    let preferenceCalls = 0
    const service = createJevLaunchRouter({
      router: fake,
      listProviders: async () => {
        providerCalls += 1
        return CLAUDE_PROVIDERS
      },
      listModels: async () => CLAUDE_CATALOGS,
      readPreferences: async () => {
        preferenceCalls += 1
        return DEFAULT_PREFERENCES
      }
    })

    await service.route({ prompt: 'one' })
    await service.route({ prompt: 'two' })

    expect(providerCalls).toBe(2)
    expect(preferenceCalls).toBe(2)
  })

  it('sends the routing profile Settings currently holds', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(answers())
    const service = serviceWith({
      router: fake,
      preferences: { profile: 'premium', default: {} }
    })

    await service.route({ prompt: 'anything' })

    expect(fake.requestsSeen()[0]!.routingProfile).toBe('premium')
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

  it("attaches the user's own configured default to a fallback, and says so", async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({ kind: 'fallback', reason: 'unreachable' })
    const service = serviceWith({
      router: fake,
      preferences: { profile: 'balanced', default: { provider: 'codex', effort: 'high' } }
    })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({
      kind: 'fallback',
      reason: 'unreachable',
      fallbackTo: { provider: 'codex', effort: 'high' }
    })
  })

  it('omits fallbackTo when no default is configured', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({ kind: 'fallback', reason: 'unreachable' })
    const service = serviceWith({ router: fake })

    const result = await service.route({ prompt: 'anything' })

    expect(result).not.toHaveProperty('fallbackTo')
  })

  /*
   * REPLACES the v1 "refuses a decision naming a provider this call cannot
   * actually launch, belt and braces" test — CHANGED assertion: v1 refused
   * the whole call with 'invalid-response'; request v2's `decideLaunch`
   * treats an unlaunchable provider answer exactly like a low-confidence one
   * (see routeDecision.ts's own provider-resolution branch) and resolves to
   * a safe-default DECISION instead, so a launch still happens rather than
   * falling back needlessly.
   */
  it('resolves to a safe-default provider when the router names one this call cannot currently launch', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(answers({ provider: { choice: 'codex', confidence: 0.95 } }))
    const service = serviceWith({
      router: fake,
      providers: [
        provider({ provider: 'claude' }),
        provider({ provider: 'codex', launchable: false })
      ],
      models: [
        catalog({ provider: 'claude', models: [{ value: 'sonnet' }] }),
        catalog({ provider: 'codex' })
      ]
    })

    const result = await service.route({ prompt: 'anything' })

    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.provider).toBe('claude')
    expect(result.parts.provider.applied).toBe('safe-default')
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
    fake.queueOutcome(answers())
    const service = serviceWith({ router: fake })

    const result = await service.route({ prompt: 'THE-SECRET-PROMPT-TEXT' })

    expect(JSON.stringify(result)).not.toContain('THE-SECRET-PROMPT-TEXT')
  })
})

/*
 * New for #547: OpenCode's own live catalogue is read fresh, derived into a
 * capability table, and injected into both the request builder and the
 * local decision — never a throw, never `MODEL_CAPABILITIES.opencode`
 * (the curated overlay only) alone. Two real, currently-catalogued ids
 * (see docs/opencode-format.md Row 6, #547's own issue text) stand in for
 * "the live catalogue this machine actually has" — a free reasoning model
 * (`opencode/big-pickle`, cost 0 → 'fast-cheap') and a paid one at the top
 * cost band (`opencode-go/kimi-k3`, $3 in / $15 out, 1,048,576-token context
 * → 'frontier').
 */
describe('createJevLaunchRouter — OpenCode capability derivation (#547)', () => {
  const FREE_FAST_CHEAP: OpenCodeCatalogueModel = {
    value: 'opencode/big-pickle',
    displayName: 'Big Pickle',
    effortLevels: [],
    status: 'active',
    releaseDate: '2025-10-17',
    cost: { input: 0, output: 0, cacheRead: 0 },
    limit: { context: 200_000, output: 32_000 },
    capabilities: { reasoning: true }
  }
  const PAID_FRONTIER: OpenCodeCatalogueModel = {
    value: 'opencode-go/kimi-k3',
    displayName: 'Kimi K3',
    effortLevels: ['max'],
    status: 'active',
    releaseDate: '2026-07-16',
    cost: { input: 3, output: 15, cacheRead: 0.3 },
    limit: { context: 1_048_576, output: 131_072 },
    capabilities: { reasoning: true }
  }

  it("omits OpenCode's own provider option, without failing the call, when its catalogue read rejects", async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(answers())
    const service = serviceWith({
      router: fake,
      providers: [provider({ provider: 'claude' }), provider({ provider: 'opencode' })],
      models: [
        catalog({ provider: 'claude', models: [{ value: 'sonnet' }] }),
        catalog({ provider: 'opencode' })
      ],
      readOpenCodeCatalogue: () => Promise.reject(new Error('opencode not installed'))
    })

    const result = await service.route({ prompt: 'anything' })

    expect(Object.keys(fake.requestsSeen()[0]!.providerCriteria).sort()).toEqual(
      ['claude', 'no_preference'].sort()
    )
    expect(result.kind).toBe('decision')
  })

  it("omits OpenCode's own provider option when its catalogue read resolves empty (not installed)", async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(answers())
    const service = serviceWith({
      router: fake,
      providers: [provider({ provider: 'claude' }), provider({ provider: 'opencode' })],
      models: [
        catalog({ provider: 'claude', models: [{ value: 'sonnet' }] }),
        catalog({ provider: 'opencode' })
      ],
      readOpenCodeCatalogue: async () => []
    })

    await service.route({ prompt: 'anything' })

    expect(Object.keys(fake.requestsSeen()[0]!.providerCriteria)).not.toContain('opencode')
  })

  it("names OpenCode's own real, derived tiers in the request sent to Jev", async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(answers({ provider: { choice: 'opencode', confidence: 0.95 } }))
    const service = serviceWith({
      router: fake,
      providers: [provider({ provider: 'opencode' })],
      models: [catalog({ provider: 'opencode', models: [{ value: FREE_FAST_CHEAP.value }] })],
      readOpenCodeCatalogue: async () => [FREE_FAST_CHEAP, PAID_FRONTIER]
    })

    await service.route({ prompt: 'anything' })

    const criteria = fake.requestsSeen()[0]!.providerCriteria.opencode!
    expect(criteria.what).toContain('fast-cheap')
    expect(criteria.what).toContain('frontier')
  })

  it('lands on a free OpenCode model at the fast-cheap tier when Jev names OpenCode and the prompt is trivial', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(
      answers({
        provider: { choice: 'opencode', confidence: 0.95 },
        trivial: { probability: 0.95 }
      })
    )
    const service = serviceWith({
      router: fake,
      providers: [provider({ provider: 'opencode' })],
      models: [catalog({ provider: 'opencode', models: [{ value: FREE_FAST_CHEAP.value }] })],
      readOpenCodeCatalogue: async () => [FREE_FAST_CHEAP, PAID_FRONTIER]
    })

    const result = await service.route({ prompt: 'thanks!' })

    if (result.kind !== 'decision') throw new Error(`expected a decision, got ${result.reason}`)
    expect(result.provider).toBe('opencode')
    expect(result.model).toBe(FREE_FAST_CHEAP.value)
    expect(result.tier).toBe('fast-cheap')
  })

  it('lands on a 1M-context OpenCode frontier model under premium when Jev answers frontier', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(
      answers({
        provider: { choice: 'opencode', confidence: 0.95 },
        tier: { choice: 'frontier', confidence: 0.95 }
      })
    )
    const service = serviceWith({
      router: fake,
      providers: [provider({ provider: 'opencode' })],
      models: [
        catalog({
          provider: 'opencode',
          models: [{ value: FREE_FAST_CHEAP.value }, { value: PAID_FRONTIER.value }]
        })
      ],
      preferences: { profile: 'premium', default: {} },
      readOpenCodeCatalogue: async () => [FREE_FAST_CHEAP, PAID_FRONTIER]
    })

    const result = await service.route({ prompt: 'design the whole new subsystem' })

    if (result.kind !== 'decision') throw new Error(`expected a decision, got ${result.reason}`)
    expect(result.provider).toBe('opencode')
    expect(result.model).toBe(PAID_FRONTIER.value)
    expect(result.tier).toBe('frontier')
  })
})

/*
 * The local-decision half of the #525 dev-console trace (jev-routing-profiles
 * T4): the SDK adapter's own debugLog (typesafeJevRouter.ts) shows the
 * request Jev was sent and the answers it gave; this service is where those
 * answers turn into a concrete provider/model/effort, so it gets its own
 * header and pretty-printed payload for the LOCAL decision, wired through
 * the identical sink (main/index.ts shares one). No prompt ever reaches this
 * line — decideLaunch's own result never carries one — so there is nothing
 * here that JEV_DEBUG's opt-in, dev-only scope does not already cover.
 */
describe('the decision debugLog trace (jev-routing-profiles T4)', () => {
  function incrementingClock(step = 10): () => number {
    let now = 0
    return () => {
      now += step
      return now
    }
  }

  it('logs a decision header and the pretty-printed local decision, with elapsedMs, once Jev answered', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(answers())
    const lines: string[] = []
    const service = serviceWith({
      router: fake,
      debugLog: (line) => lines.push(line),
      now: incrementingClock()
    })

    const result = await service.route({ prompt: 'fix the flaky test' })

    expect(result.kind).toBe('decision')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('[jev:debug] decision =')
    const payload = JSON.parse(lines[1]!) as Record<string, unknown>
    expect(payload.kind).toBe('decision')
    expect(payload.provider).toBe('claude')
    expect(payload.model).toBe('sonnet')
    expect(payload.tier).toBe('balanced')
    expect(payload.parts).toBeDefined()
    expect(typeof payload.elapsedMs).toBe('number')
  })

  it('logs a decision block for a decision that itself fell back to a safe-default provider', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(answers({ provider: { choice: 'codex', confidence: 0.95 } }))
    const lines: string[] = []
    const service = serviceWith({
      router: fake,
      providers: [
        provider({ provider: 'claude' }),
        provider({ provider: 'codex', launchable: false })
      ],
      models: [
        catalog({ provider: 'claude', models: [{ value: 'sonnet' }] }),
        catalog({ provider: 'codex' })
      ],
      debugLog: (line) => lines.push(line)
    })

    await service.route({ prompt: 'anything' })

    expect(lines).toHaveLength(2)
    const payload = JSON.parse(lines[1]!) as Record<string, unknown>
    expect(payload.provider).toBe('claude')
  })

  it('logs nothing when the request was skipped before Jev was ever asked', async () => {
    const fake = new FakeJevRouter()
    const lines: string[] = []
    const service = serviceWith({
      router: fake,
      providers: [provider({ provider: 'claude', launchable: false })],
      debugLog: (line) => lines.push(line)
    })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({ kind: 'fallback', reason: 'no-launchable-provider' })
    expect(lines).toEqual([])
  })

  it('logs nothing when Jev itself fell back — there is no local decision to show', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome({ kind: 'fallback', reason: 'unreachable' })
    const lines: string[] = []
    const service = serviceWith({ router: fake, debugLog: (line) => lines.push(line) })

    const result = await service.route({ prompt: 'anything' })

    expect(result).toEqual({ kind: 'fallback', reason: 'unreachable' })
    expect(lines).toEqual([])
  })

  it('behaves identically with no debugLog sink', async () => {
    const fake = new FakeJevRouter()
    fake.queueOutcome(answers())
    const service = serviceWith({ router: fake })

    const result = await service.route({ prompt: 'fix the flaky test' })

    expect(result.kind).toBe('decision')
  })
})
