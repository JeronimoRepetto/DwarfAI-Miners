import { describe, expect, it } from 'vitest'
import { FakeJevRouter } from '../ports/fakes/FakeJevRouter'
import type { JevModelResponse } from '../ports/jevRouter'
import { MODEL_CAPABILITIES, type ModelCapabilityEntry } from './capabilities/modelCapability'
import {
  decideLaunch,
  type JevCapabilityTable,
  type JevRouteAnswers,
  type RoutingModelCatalog
} from './routeDecision'
import { buildJevModelRouteRequest, type RoutingProviderOption } from './routeRequest'
import {
  overallConfidence,
  planModelStep,
  safeDefaultModel,
  settleModelStep,
  type LaunchDecision
} from './routeModel'

/*
 * The second (model) request's decision (#608), transplanted from the model-step cases of the
 * found tree's `routeLaunch.test.ts` (`createJevLaunchRouter — the second (model) request`). The
 * orchestration around it — the router call, the shared budget, the abort signal, the debug trace —
 * is the application's (ISSUE-192), so each case here feeds the router's answer through
 * `FakeJevRouter` in test code and asks the pure domain what it means. The fixtures are the REAL
 * capability-table ids the original suite used ('sonnet' balanced/medium, 'default' balanced/
 * unverified).
 */

const KEY = 'test-jev-key'
const CLAUDE: RoutingProviderOption[] = [{ provider: 'claude', installed: true, launchable: true }]
const TWO_CANDIDATE_CATALOGS: RoutingModelCatalog[] = [
  {
    provider: 'claude',
    models: [{ value: 'default' }, { value: 'sonnet' }],
    efforts: [],
    source: 'none'
  }
]

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

function decide(
  catalogs: RoutingModelCatalog[],
  first: JevRouteAnswers = answers(),
  capabilities: JevCapabilityTable = MODEL_CAPABILITIES
): LaunchDecision {
  const decided = decideLaunch({
    answers: first,
    profile: 'balanced',
    providers: CLAUDE,
    catalogs,
    capabilities,
    userDefault: {}
  })
  if (decided.kind !== 'decision') throw new Error(`expected a decision, got ${decided.reason}`)
  return decided
}

/** Builds the second request over the decision's candidates and asks the fake router. */
async function askSecond(
  decided: LaunchDecision,
  response: JevModelResponse
): Promise<{ fake: FakeJevRouter; answer: JevModelResponse }> {
  const plan = planModelStep(decided)
  if (plan.kind !== 'ask') throw new Error('expected a second request')
  const built = buildJevModelRouteRequest({
    prompt: 'add a field to this form',
    routingProfile: 'balanced',
    tier: plan.tier,
    candidates: plan.candidates
  })
  if (built.kind !== 'request') throw new Error('expected a request')
  const fake = new FakeJevRouter()
  fake.queueModelResponse(response)
  return { fake, answer: await fake.routeModel(built.request, KEY) }
}

describe('the second (model) request (#608)', () => {
  it('sends a second request keyed by index over every live candidate — never a model id or name — and applies the winner', async () => {
    const decided = decide(TWO_CANDIDATE_CATALOGS)
    const { fake, answer } = await askSecond(decided, {
      kind: 'answers',
      fits: { '0': 0.2, '1': 0.9 },
      choice: { choice: '1', probabilities: { '0': 0.1, '1': 0.9 } },
      usage: { inputTokens: 300 }
    })

    expect(fake.modelRequestsSeen()).toHaveLength(1)
    const sent = fake.modelRequestsSeen()[0]!
    expect(Object.keys(sent.candidates)).toEqual(['0', '1'])
    expect(sent.candidates['1']!.relativeCost).toBe('medium') // confirms index '1' is 'sonnet'
    expect(JSON.stringify(sent)).not.toMatch(/sonnet|default/)

    const result = settleModelStep({
      decided,
      response: answer,
      effortScore: 1.5,
      profile: 'balanced'
    })
    if (result.kind !== 'model') throw new Error(`expected a model, got ${result.reason}`)
    expect(result.model).toBe('sonnet')
    expect(result.effort).toBe('high')
    expect(result.part).toEqual({ value: 'sonnet', applied: 'answered', probability: 0.9 })
  })

  it('sends no second request, and marks the model as no-live-model, when nothing is live for the chosen provider at any tier', () => {
    const decided = decide([{ provider: 'claude', models: [], efforts: [], source: 'none' }])
    const plan = planModelStep(decided)

    expect(plan).toEqual({
      kind: 'model',
      part: { applied: 'safe-default', reason: 'no-live-model' }
    })
  })

  it('sends no second request for exactly one live candidate, and marks the model only-candidate', () => {
    const decided = decide([
      { provider: 'claude', models: [{ value: 'sonnet' }], efforts: [], source: 'none' }
    ])
    const plan = planModelStep(decided)

    expect(plan).toEqual({
      kind: 'model',
      model: 'sonnet',
      effort: 'high',
      part: { value: 'sonnet', applied: 'only-candidate' }
    })
  })

  it.each([
    ['timeout' as const],
    ['unreachable' as const],
    ['rate-limited' as const],
    ['invalid-response' as const]
  ])(
    'falls back to the local cost/profile safe default, and says why, when request 2 fails with %s',
    async (reason) => {
      const decided = decide(TWO_CANDIDATE_CATALOGS)
      const { answer } = await askSecond(decided, { kind: 'fallback', reason })

      const result = settleModelStep({
        decided,
        response: answer,
        effortScore: 1.5,
        profile: 'balanced'
      })
      if (result.kind !== 'model') throw new Error(`expected a model, got ${result.reason}`)
      // cheapestOrPriciestCandidate's own safe pick between 'default' (unverified) and 'sonnet'
      // (medium) is the cheaper, verified one — 'sonnet'.
      expect(result.model).toBe('sonnet')
      expect(result.part).toEqual({ value: 'sonnet', applied: 'safe-default', reason })
    }
  )

  it('settles on the safe default with budget-exceeded when request 2 is skipped for the budget', () => {
    const decided = decide(TWO_CANDIDATE_CATALOGS)

    expect(safeDefaultModel(decided, 'budget-exceeded')).toEqual({
      kind: 'model',
      model: 'sonnet',
      effort: 'high',
      part: { value: 'sonnet', applied: 'safe-default', reason: 'budget-exceeded' }
    })
  })

  it('folds the model part into the overall confidence, alongside provider and tier — ignoring a safe-default provider (#608 card bug)', async () => {
    const decided = decide(
      TWO_CANDIDATE_CATALOGS,
      answers({
        provider: { choice: 'claude', confidence: 0.19 }, // below the floor — safe-default, excluded
        tier: { choice: 'balanced', confidence: 0.91 }
      })
    )
    const { answer } = await askSecond(decided, {
      kind: 'answers',
      fits: { '0': 0.1, '1': 0.8 },
      choice: { choice: '1', probabilities: { '0': 0.2, '1': 0.8 } },
      usage: { inputTokens: 300 }
    })

    const result = settleModelStep({
      decided,
      response: answer,
      effortScore: 1.5,
      profile: 'balanced'
    })
    if (result.kind !== 'model') throw new Error(`expected a model, got ${result.reason}`)
    expect(decided.parts.provider.applied).toBe('safe-default')
    // MIN(tier 0.91, model 0.8) — the discarded 0.19 provider confidence never enters it.
    expect(overallConfidence(decided, result.part)).toBe(0.8)
  })
})

describe('the second request under the effort ceiling (ADR-028)', () => {
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
      verifiedOn: '2026-10-15',
      ...overrides
    }
  }

  /** A decision whose second-request candidates include ones that cannot honour the ceiling. */
  function decisionWith(options: LaunchDecision['modelCandidates']['options']): LaunchDecision {
    const decided = decide([
      { provider: 'claude', models: [{ value: 'sonnet' }], efforts: [], source: 'none' }
    ])
    return { ...decided, modelCandidates: { tier: 'balanced', options } }
  }

  it('[ADR-028] the second request removes none candidates before selecting the winner and falls back with effort-ceiling when none is left', async () => {
    // Score 0 maps to claude's 'low'; index '0' accepts only levels above it.
    const highOnly = {
      id: 'c-high-only',
      entry: entry({ tier: 'balanced', effortLevels: ['xhigh', 'max'] })
    }
    const lowOk = {
      id: 'c-low-ok',
      entry: entry({ tier: 'balanced', effortLevels: ['low', 'medium'] })
    }
    const preferHighOnly: JevModelResponse = {
      kind: 'answers',
      fits: { '0': 0.95, '1': 0.4 },
      choice: { choice: '0', probabilities: { '0': 0.9, '1': 0.1 } },
      usage: { inputTokens: 300 }
    }

    const mixed = decisionWith([highOnly, lowOk])
    const { answer } = await askSecond(mixed, preferHighOnly)
    const picked = settleModelStep({
      decided: mixed,
      response: answer,
      effortScore: 0,
      profile: 'balanced'
    })
    if (picked.kind !== 'model') throw new Error(`expected a model, got ${picked.reason}`)
    expect(picked.model).toBe('c-low-ok')
    expect(picked.effort).toBe('low')
    expect(picked.part).toEqual({ value: 'c-low-ok', applied: 'answered', probability: 0.4 })

    const allHighOnly = decisionWith([
      highOnly,
      { id: 'c-high-too', entry: entry({ tier: 'balanced', effortLevels: ['high', 'max'] }) }
    ])
    const second = await askSecond(allHighOnly, preferHighOnly)
    expect(
      settleModelStep({
        decided: allHighOnly,
        response: second.answer,
        effortScore: 0,
        profile: 'balanced'
      })
    ).toEqual({ kind: 'fallback', reason: 'effort-ceiling' })
  })
})
