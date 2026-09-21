import { describe, expect, it } from 'vitest'
import type { AgentModelCatalog, AgentProviderOption, DwarfProvider } from '../domain/types'
import type { ModelCapabilityEntry } from './capabilities/modelCapability'
import type { JevRouteAnswers } from './jevRouterPort'
import {
  LARGE_CONTEXT_FLOOR,
  PROVIDER_CONFIDENCE_FLOOR,
  TIER_CONFIDENCE_FLOOR,
  TRIVIAL_FLOOR,
  decideLaunch,
  type JevCapabilityTable
} from './routeDecision'

/**
 * `decideLaunch` is the LOCAL decision (jev-routing-profiles T3): pure, no
 * network, given Jev's already-answered five questions plus the profile,
 * the live provider/catalogue set, the capability table and the user's own
 * default. A small SYNTHETIC capability table is used throughout rather than
 * the real `MODEL_CAPABILITIES` — this suite is about the MAPPING rule, not
 * about any one provider's real catalogue (that is `capabilities.test.ts`'s
 * job), and a synthetic table can exercise stepping/cost tie-breaks the real
 * one may not currently have a case for (no live table tags anything
 * `'long-context'` yet).
 */

function entry(
  overrides: Partial<ModelCapabilityEntry> & Pick<ModelCapabilityEntry, 'tier'>
): ModelCapabilityEntry {
  return {
    what: 'test fixture',
    notFor: 'test fixture',
    examples: ['a', 'b'],
    launchTarget: true,
    effortLevels: 'all',
    relativeCost: 'medium',
    sources: ['test fixture'],
    verifiedOn: '2026-09-21',
    ...overrides
  }
}

const CAPABILITIES: JevCapabilityTable = {
  claude: {
    'c-fast': entry({ tier: 'fast-cheap', relativeCost: 'medium' }),
    'c-bal': entry({ tier: 'balanced', relativeCost: 'medium', contextWindowTokens: 1_000_000 }),
    'c-front': entry({ tier: 'frontier', relativeCost: 'high' }),
    'c-hidden': entry({ tier: 'balanced', launchTarget: false, relativeCost: 'low' })
  },
  codex: {
    'x-fast': entry({ tier: 'fast-cheap', relativeCost: 'low' }),
    'x-bal': entry({
      tier: 'balanced',
      relativeCost: 'medium',
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
    })
    // No frontier entry for codex on purpose — exercises the step-down rule.
  },
  antigravity: {},
  opencode: {}
}

const ALL_CLAUDE_CODEX_LIVE: readonly AgentModelCatalog[] = [
  {
    provider: 'claude',
    models: [{ value: 'c-fast' }, { value: 'c-bal' }, { value: 'c-front' }],
    efforts: [],
    source: 'provider'
  },
  {
    provider: 'codex',
    models: [{ value: 'x-fast' }, { value: 'x-bal' }],
    efforts: [],
    source: 'history'
  }
]

function providers(...launchable: DwarfProvider[]): AgentProviderOption[] {
  return launchable.map((provider) => ({ provider, installed: true, launchable: true }))
}

function answers(overrides: Partial<JevRouteAnswers> = {}): JevRouteAnswers {
  return {
    kind: 'answers',
    provider: { choice: 'claude', confidence: 0.9 },
    tier: { choice: 'balanced', confidence: 0.9 },
    trivial: { probability: 0.05 },
    largeContext: { probability: 0.05 },
    effort: { score: 1.5 },
    usage: { inputTokens: 100 },
    ...overrides
  }
}

describe('decideLaunch — floors and the profile rule (table-driven)', () => {
  it.each([
    // [label, tier answer, tier confidence, trivial probability, profile, effort score, expected tier, expected applied]
    [
      'a trivial prompt forces fast-cheap under every profile',
      'frontier',
      0.95,
      0.95,
      'premium',
      3,
      'fast-cheap',
      'safe-default'
    ],
    [
      'economy caps a confident frontier answer down to balanced',
      'frontier',
      0.9,
      0.05,
      'economy',
      3,
      'balanced',
      'safe-default'
    ],
    [
      'balanced keeps a confident frontier answer as frontier',
      'frontier',
      0.9,
      0.05,
      'balanced',
      3,
      'frontier',
      'answered'
    ],
    [
      'premium promotes a confident balanced answer to frontier when the effort score is high',
      'balanced',
      0.9,
      0.05,
      'premium',
      2,
      'frontier',
      'safe-default'
    ],
    [
      'premium does NOT promote balanced when the effort score is low',
      'balanced',
      0.9,
      0.05,
      'premium',
      1,
      'balanced',
      'answered'
    ],
    [
      'a low-confidence tier answer falls back to balanced',
      'frontier',
      TIER_CONFIDENCE_FLOOR - 0.01,
      0.05,
      'balanced',
      1,
      'balanced',
      'safe-default'
    ],
    [
      'a no_preference tier answer falls back to balanced',
      'no_preference',
      0.99,
      0.05,
      'balanced',
      1,
      'balanced',
      'safe-default'
    ]
  ] as const)(
    '%s',
    (
      _label,
      tierChoice,
      tierConfidence,
      trivialProbability,
      profile,
      effortScore,
      expectedTier,
      expectedApplied
    ) => {
      const result = decideLaunch({
        answers: answers({
          tier: { choice: tierChoice, confidence: tierConfidence },
          trivial: { probability: trivialProbability },
          effort: { score: effortScore }
        }),
        profile,
        providers: providers('claude', 'codex'),
        catalogs: ALL_CLAUDE_CODEX_LIVE,
        capabilities: CAPABILITIES,
        userDefault: {}
      })

      if (result.kind !== 'decision')
        throw new Error(`expected a decision, got fallback: ${result.reason}`)
      expect(result.tier).toBe(expectedTier)
      expect(result.parts.tier.applied).toBe(expectedApplied)
    }
  )
})

describe('decideLaunch — the provider part', () => {
  it('applies a confident, launchable provider answer as-is', () => {
    const result = decideLaunch({
      answers: answers({ provider: { choice: 'codex', confidence: 0.95 } }),
      profile: 'balanced',
      providers: providers('claude', 'codex'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.provider).toBe('codex')
    expect(result.parts.provider.applied).toBe('answered')
  })

  it('falls back to the configured user default when the provider answer is unsure', () => {
    const result = decideLaunch({
      answers: answers({ provider: { choice: 'no_preference', confidence: 0.99 } }),
      profile: 'balanced',
      providers: providers('claude', 'codex'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: { provider: 'codex' }
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.provider).toBe('codex')
    expect(result.parts.provider.applied).toBe('safe-default')
  })

  it('ignores a configured user default naming a provider this call cannot currently launch', () => {
    const result = decideLaunch({
      answers: answers({ provider: { choice: 'no_preference', confidence: 0.99 } }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: { provider: 'codex' }
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.provider).toBe('claude')
  })

  it('picks the launchable provider with the cheapest entry at the resolved tier when unsure and no default is set', () => {
    // Both providers launchable; codex's fast-cheap entry is 'low', claude's is 'medium'.
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'no_preference', confidence: 0.99 },
        trivial: { probability: 0.99 } // forces the fast-cheap tier
      }),
      profile: 'balanced',
      providers: providers('claude', 'codex'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.provider).toBe('codex')
  })

  it('breaks a cost-band tie by contract provider order, so a free OpenCode model does not beat a low-band Claude one (AMENDED for #547 review: known limitation, pinned)', () => {
    // A derived OpenCode entry for a FREE model and a curated Claude entry both
    // band as 'low' — the table carries bands, not prices (#335 keeps cost off
    // the wire), so `cheapestLaunchableProviderFor` cannot see that $0 beats
    // $1 and falls to DWARF_PROVIDERS order, where claude comes first. A free
    // OpenCode model therefore lands only when Jev names OpenCode, or it is
    // the person's own default provider. Pinned so the day the tie-break
    // learns exact cost, this test is the one that has to change on purpose.
    const table: JevCapabilityTable = {
      ...CAPABILITIES,
      claude: { 'c-cheap': entry({ tier: 'fast-cheap', relativeCost: 'low' }) },
      opencode: { 'opencode/free': entry({ tier: 'fast-cheap', relativeCost: 'low' }) }
    }
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'no_preference', confidence: 0.99 },
        trivial: { probability: 0.99 }
      }),
      profile: 'balanced',
      providers: providers('claude', 'opencode'),
      catalogs: [
        { provider: 'claude', models: [{ value: 'c-cheap' }], efforts: [], source: 'provider' },
        {
          provider: 'opencode',
          models: [{ value: 'opencode/free' }],
          efforts: [],
          source: 'provider'
        }
      ],
      capabilities: table,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.provider).toBe('claude')
    expect(result.model).toBe('c-cheap')
  })

  it('lands on the free OpenCode model when OpenCode is the configured default provider and Jev has no preference', () => {
    const table: JevCapabilityTable = {
      ...CAPABILITIES,
      claude: { 'c-cheap': entry({ tier: 'fast-cheap', relativeCost: 'low' }) },
      opencode: { 'opencode/free': entry({ tier: 'fast-cheap', relativeCost: 'low' }) }
    }
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'no_preference', confidence: 0.99 },
        trivial: { probability: 0.99 }
      }),
      profile: 'balanced',
      providers: providers('claude', 'opencode'),
      catalogs: [
        { provider: 'claude', models: [{ value: 'c-cheap' }], efforts: [], source: 'provider' },
        {
          provider: 'opencode',
          models: [{ value: 'opencode/free' }],
          efforts: [],
          source: 'provider'
        }
      ],
      capabilities: table,
      userDefault: { provider: 'opencode' }
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.provider).toBe('opencode')
    expect(result.model).toBe('opencode/free')
  })
})

describe('decideLaunch — concrete model selection', () => {
  it('steps down one tier at a time when the chosen provider has no entry at the resolved tier', () => {
    // codex has no frontier entry — should step down to its balanced one.
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'codex', confidence: 0.95 },
        tier: { choice: 'frontier', confidence: 0.95 }
      }),
      profile: 'balanced',
      providers: providers('codex'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.model).toBe('x-bal')
  })

  it('treats a capability entry absent from the LIVE catalogue as no entry, and steps down past it', () => {
    const liveWithoutCFront: readonly AgentModelCatalog[] = [
      {
        provider: 'claude',
        models: [{ value: 'c-fast' }, { value: 'c-bal' }],
        efforts: [],
        source: 'provider'
      }
    ]
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'claude', confidence: 0.95 },
        tier: { choice: 'frontier', confidence: 0.95 }
      }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: liveWithoutCFront,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.model).toBe('c-bal')
  })

  it('prefers a large-context-capable entry within the chosen tier when needs_large_context is confidently true', () => {
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'claude', confidence: 0.95 },
        tier: { choice: 'balanced', confidence: 0.95 },
        largeContext: { probability: LARGE_CONTEXT_FLOOR + 0.01 }
      }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    // Only c-bal carries a >=1M context window in the balanced tier.
    expect(result.model).toBe('c-bal')
  })

  it('keeps the ordinary tier pick when needs_large_context is true but nothing in the tier qualifies', () => {
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'codex', confidence: 0.95 },
        tier: { choice: 'fast_cheap', confidence: 0.95 },
        largeContext: { probability: LARGE_CONTEXT_FLOOR + 0.01 }
      }),
      profile: 'balanced',
      providers: providers('codex'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    // codex's fast-cheap entry (x-fast) has no contextWindowTokens at all — still the pick.
    expect(result.model).toBe('x-fast')
  })
})

describe('decideLaunch — effort', () => {
  it('offers no effort level for a model whose own effortLevels is empty', () => {
    const noEffortCapabilities: JevCapabilityTable = {
      ...CAPABILITIES,
      claude: { ...CAPABILITIES.claude, 'c-bal': entry({ tier: 'balanced', effortLevels: [] }) }
    }
    const result = decideLaunch({
      answers: answers({ provider: { choice: 'claude', confidence: 0.95 } }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: noEffortCapabilities,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.model).toBe('c-bal')
    expect(result.effort).toBeUndefined()
  })

  it("narrows a mapped 'ultra' effort to the nearest level the chosen model's own ladder actually accepts", () => {
    // Score 3 maps to codex's own top level, 'ultra' — but x-bal's fixture
    // ladder above stops at 'max'.
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'codex', confidence: 0.95 },
        tier: { choice: 'balanced', confidence: 0.95 },
        effort: { score: 3 }
      }),
      profile: 'balanced',
      providers: providers('codex'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.model).toBe('x-bal')
    expect(result.effort).toBe('max')
  })
})

describe('decideLaunch — overall confidence and parts', () => {
  it('reports the overall confidence as the MIN of the provider and tier confidences', () => {
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'claude', confidence: 0.95 },
        tier: { choice: 'balanced', confidence: 0.4 }
      }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.confidence).toBe(0.4)
  })

  it('reports the trivial and large-context parts as floored booleans with their raw probability', () => {
    const result = decideLaunch({
      answers: answers({
        trivial: { probability: TRIVIAL_FLOOR - 0.01 },
        largeContext: { probability: LARGE_CONTEXT_FLOOR + 0.01 }
      }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.parts.trivial).toEqual({ value: false, probability: TRIVIAL_FLOOR - 0.01 })
    expect(result.parts.largeContext).toEqual({
      value: true,
      probability: LARGE_CONTEXT_FLOOR + 0.01
    })
  })
})

describe('the exported floors', () => {
  it('match the orchestrator decision recorded in odd/tasks/jev-routing-profiles.md', () => {
    expect(PROVIDER_CONFIDENCE_FLOOR).toBe(0.6)
    expect(TIER_CONFIDENCE_FLOOR).toBe(0.7)
    expect(TRIVIAL_FLOOR).toBe(0.75)
    expect(LARGE_CONTEXT_FLOOR).toBe(0.75)
  })
})
