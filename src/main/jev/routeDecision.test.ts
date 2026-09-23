import { describe, expect, it } from 'vitest'
import type { AgentModelCatalog, AgentProviderOption, DwarfProvider } from '../domain/types'
import type { ModelCapabilityEntry } from './capabilities/modelCapability'
import type { JevRouteAnswers } from './jevRouterPort'
import {
  LARGE_CONTEXT_FLOOR,
  MODEL_TIE_BAND,
  PROVIDER_CONFIDENCE_FLOOR,
  TIER_CONFIDENCE_FLOOR,
  TRIVIAL_FLOOR,
  decideLaunch,
  finalizeModel,
  selectModelWinner,
  type JevCapabilityTable,
  type ModelSelectionCandidate
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
  /*
   * AMENDED for #608 (was: tier confidence 0.4, expecting an overall 0.4).
   * 0.4 is BELOW TIER_CONFIDENCE_FLOOR (0.7), so that fixture's tier part
   * was always 'safe-default' — under the OLD rule (MIN of every part's raw
   * confidence, applied or not) that still dragged the overall number down
   * to 0.4; under the #608 fix (MIN over only the ANSWERED parts) a
   * safe-default tier is excluded, so the old fixture no longer exercises a
   * genuine "MIN of two answered parts" case. Raised to 0.75 (above the
   * floor, so both parts are 'answered') to keep testing exactly that; the
   * excluded-safe-default case now has its own test right below.
   */
  it('reports the overall confidence as the MIN of the provider and tier confidences, when both were answered', () => {
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'claude', confidence: 0.95 },
        tier: { choice: 'balanced', confidence: 0.75 }
      }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.confidence).toBe(0.75)
  })

  /*
   * New for #608: the launch-card bug the issue itself names — a discarded
   * part's raw confidence (provider at 19%, well below
   * PROVIDER_CONFIDENCE_FLOOR) must not drag the overall number down once
   * that part fell back to a safe default instead of being acted on.
   */
  it('ignores a safe-default provider part’s own confidence in the overall number (#608 card bug)', () => {
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'claude', confidence: 0.19 },
        tier: { choice: 'balanced', confidence: 0.9 }
      }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.parts.provider.applied).toBe('safe-default')
    expect(result.confidence).toBe(0.9)
  })

  it('reports confidence as undefined when neither the provider nor the tier was answered', () => {
    const result = decideLaunch({
      answers: answers({
        provider: { choice: 'no_preference', confidence: 0.99 },
        tier: { choice: 'no_preference', confidence: 0.99 }
      }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: ALL_CLAUDE_CODEX_LIVE,
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.parts.provider.applied).toBe('safe-default')
    expect(result.parts.tier.applied).toBe('safe-default')
    expect(result.confidence).toBeUndefined()
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

/*
 * #608: decideLaunch now also exposes every live, launchable candidate at
 * the tier the local model pick actually landed on (after step-down) — routeLaunch.ts's
 * own input for the second Jev request. `CAPABILITIES` above has only one
 * non-hidden entry per tier, so these tests build their own small table with
 * a genuine same-tier sibling.
 */
describe('decideLaunch — modelCandidates (#608)', () => {
  const TWO_AT_BALANCED: JevCapabilityTable = {
    claude: {
      'c-bal-a': entry({ tier: 'balanced', relativeCost: 'low' }),
      'c-bal-b': entry({ tier: 'balanced', relativeCost: 'high' })
    },
    codex: {},
    antigravity: {},
    opencode: {}
  }
  const TWO_AT_BALANCED_LIVE: readonly AgentModelCatalog[] = [
    {
      provider: 'claude',
      models: [{ value: 'c-bal-a' }, { value: 'c-bal-b' }],
      efforts: [],
      source: 'provider'
    }
  ]

  it('lists every live candidate at the resolved tier, not just the one that was chosen', () => {
    const result = decideLaunch({
      answers: answers({ provider: { choice: 'claude', confidence: 0.95 } }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: TWO_AT_BALANCED_LIVE,
      capabilities: TWO_AT_BALANCED,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.model).toBe('c-bal-a') // cheapest, balanced profile — the local model pick's own default
    expect(result.modelCandidates.tier).toBe('balanced')
    expect(result.modelCandidates.options.map((c) => c.id).sort()).toEqual(['c-bal-a', 'c-bal-b'])
  })

  it('reports the STEPPED tier honestly when the resolved tier has no live entry', () => {
    // codex has no frontier entry in CAPABILITIES — steps down to balanced.
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
    expect(result.tier).toBe('frontier') // the routing decision's own tier — unchanged
    expect(result.modelCandidates.tier).toBe('balanced') // the tier a candidate actually exists at
    expect(result.modelCandidates.options.map((c) => c.id)).toEqual(['x-bal'])
  })

  it('reports an empty candidate list, at the originally resolved tier, when nothing lives at any step', () => {
    const result = decideLaunch({
      answers: answers({ provider: { choice: 'claude', confidence: 0.95 } }),
      profile: 'balanced',
      providers: providers('claude'),
      catalogs: [], // nothing live at all
      capabilities: CAPABILITIES,
      userDefault: {}
    })
    if (result.kind !== 'decision') throw new Error('expected a decision')
    expect(result.model).toBeUndefined()
    expect(result.modelCandidates).toEqual({ tier: 'balanced', options: [] })
  })
})

/*
 * finalizeModel is the shared tail end of "pick a model" — effort mapping
 * plus the belt-and-braces `parseLaunchTuning` check — that both
 * `decideLaunch`'s own local model choice and #608's request-2 winner need,
 * written once so neither path can silently disagree about what a valid
 * (model, effort) pairing is.
 */
describe('finalizeModel', () => {
  it('maps the effort score onto the ladder and narrows it to the model’s own accepted levels', () => {
    const result = finalizeModel(
      'codex',
      'x-bal',
      entry({ tier: 'balanced', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }),
      3 // maps to codex's own top level, 'ultra' — not in this model's own ladder
    )
    expect(result).toEqual({ model: 'x-bal', effort: 'max' })
  })

  it('omits effort for a model whose own effortLevels is empty', () => {
    const result = finalizeModel(
      'claude',
      'c-bal',
      entry({ tier: 'balanced', effortLevels: [] }),
      1.5
    )
    expect(result).toEqual({ model: 'c-bal' })
  })
})

/*
 * selectModelWinner (#608): the highest Noul wins; a top-two gap under
 * MODEL_TIE_BAND lets the Choice's own probabilities decide among the tied
 * candidates; an exact tie on both falls back to the local model pick's own
 * cost/profile order — deterministic, never arbitrary.
 */
describe('selectModelWinner', () => {
  function candidate(
    key: string,
    id: string,
    relativeCost: ModelCapabilityEntry['relativeCost'] = 'medium'
  ): ModelSelectionCandidate {
    return { key, id, entry: entry({ tier: 'balanced', relativeCost }) }
  }

  it('is undefined for an empty candidate list', () => {
    expect(
      selectModelWinner([], {}, { choice: '0', probabilities: { '0': 1 } }, 'balanced')
    ).toBeUndefined()
  })

  it('picks the single highest Noul when the gap clears the tie band', () => {
    const candidates = [candidate('0', 'a'), candidate('1', 'b')]
    const result = selectModelWinner(
      candidates,
      { '0': 0.9, '1': 0.9 - MODEL_TIE_BAND - 0.01 },
      { choice: '1', probabilities: { '0': 0.2, '1': 0.8 } }, // Choice disagrees — must not matter here
      'balanced'
    )
    expect(result?.candidate.id).toBe('a')
    expect(result?.probability).toBe(0.9)
    expect(result?.choiceProbability).toBeUndefined()
  })

  it('lets the Choice probabilities decide among candidates within the tie band', () => {
    const candidates = [candidate('0', 'a'), candidate('1', 'b'), candidate('2', 'c')]
    const result = selectModelWinner(
      candidates,
      // '1' sits comfortably inside the 0.02 band (gap 0.015); '2' is far off, out of it.
      { '0': 0.9, '1': 0.885, '2': 0.1 },
      { choice: '1', probabilities: { '0': 0.3, '1': 0.6, '2': 0.1 } },
      'balanced'
    )
    expect(result?.candidate.id).toBe('b')
    expect(result?.probability).toBe(0.885)
    expect(result?.choiceProbability).toBe(0.6)
  })

  it('falls back to the local model pick’s own cost order when both the Noul and the Choice tie exactly', () => {
    const candidates = [candidate('0', 'expensive', 'high'), candidate('1', 'cheap', 'low')]
    const result = selectModelWinner(
      candidates,
      { '0': 0.7, '1': 0.7 },
      { choice: '0', probabilities: { '0': 0.5, '1': 0.5 } },
      'balanced' // balanced/economy pick the cheapest, premium the priciest
    )
    expect(result?.candidate.id).toBe('cheap')
  })

  it('honours the premium profile’s own priciest-first order in that same fallback', () => {
    const candidates = [candidate('0', 'expensive', 'high'), candidate('1', 'cheap', 'low')]
    const result = selectModelWinner(
      candidates,
      { '0': 0.7, '1': 0.7 },
      { choice: '0', probabilities: { '0': 0.5, '1': 0.5 } },
      'premium'
    )
    expect(result?.candidate.id).toBe('expensive')
  })

  /*
   * Verifier fix (#608), defense in depth: `typesafeJevRouter.ts`'s own
   * `isValidProbability` check keeps NaN/out-of-range values out of a real
   * wire answer, but `selectModelWinner` is a PURE function any caller can
   * reach directly (as these tests do) — it must never crash on malformed
   * input either. `NaN` propagates through `Math.max`/subtraction
   * (`NaN <= x` is always false), which can empty out the tied-candidate
   * list entirely; `cheapestOrPriciestCandidate` must never be called with
   * that empty list.
   */
  it('is undefined, rather than throwing, when every Noul probability is NaN', () => {
    const candidates = [candidate('0', 'a'), candidate('1', 'b')]
    const result = selectModelWinner(
      candidates,
      { '0': Number.NaN, '1': Number.NaN },
      { choice: '0', probabilities: { '0': 1, '1': 0 } },
      'balanced'
    )
    expect(result).toBeUndefined()
  })

  it('is undefined, rather than throwing, when the Noul probabilities tie but every Choice probability is NaN', () => {
    const candidates = [candidate('0', 'a'), candidate('1', 'b')]
    const result = selectModelWinner(
      candidates,
      { '0': 0.8, '1': 0.8 },
      { choice: '0', probabilities: { '0': Number.NaN, '1': Number.NaN } },
      'balanced'
    )
    expect(result).toBeUndefined()
  })
})
