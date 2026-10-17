import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import {
  EFFORT_QUESTION_INSTRUCTIONS,
  EFFORT_RUBRIC,
  IS_TRIVIAL_CRITERIA,
  IS_TRIVIAL_INSTRUCTIONS,
  MODEL_TIER_CRITERIA,
  MODEL_TIER_QUESTION_INSTRUCTIONS,
  NEEDS_LARGE_CONTEXT_CRITERIA,
  NEEDS_LARGE_CONTEXT_INSTRUCTIONS,
  PROVIDER_QUESTION_INSTRUCTIONS,
  modelChoiceInstructions,
  modelFitInstructions
} from '../../domain/routeRequest'
import type { JevModelRequest } from '../../ports/jevRouter'
import {
  CONTRACT_JEV_KEY,
  CONTRACT_MODEL_REQUEST,
  CONTRACT_ROUTE_REQUEST,
  runJevRouterContract,
  type JevRouterScript
} from '../../testing/jevRouter.contract'
import { answerFor, scriptedTypesafeFetch } from './testing/scriptedTypesafeFetch'
import { TypesafeJevRouter } from './TypesafeJevRouter'

// L3 (17 §1.3): the real adapter over the SDK, with the SDK's own `fetch` option replaced by a
// scripted stand-in (`TypeSafeClientConfig.fetch`): no network. The SDK itself is real.

function subjectFor(script: JevRouterScript) {
  const clock = new FakeClock()
  const scripted = scriptedTypesafeFetch(script)
  const log = new RecordingDiagnosticsLog()
  const router = new TypesafeJevRouter({
    scheduler: new FakeScheduler(clock),
    log,
    fetch: scripted.fetch
  })
  return { router, clock, log, scripted, requestsSent: () => scripted.sent.length }
}

/** A fetch that answers the first request with `answers` overridden by `edit`. */
function editedAnswers(edit: (answers: Record<string, Record<string, unknown>>) => void) {
  return (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string) as { questions: never }
    const result = answerFor(body.questions) as { answers: Record<string, Record<string, unknown>> }
    edit(result.answers)
    return Promise.resolve(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
  }
}

function routerOver(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const log = new RecordingDiagnosticsLog()
  const clock = new FakeClock()
  return { router: new TypesafeJevRouter({ scheduler: new FakeScheduler(clock), log, fetch }), log }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('TypesafeJevRouter', () => {
  runJevRouterContract(subjectFor)

  it('[INV-88, NFR-PRIV-01] sends the documented first request: the prompt and profile in state, the five questions, the key only as the bearer', async () => {
    const subject = subjectFor({ kind: 'answers' })
    const outcome = await subject.router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)

    const [sent] = subject.scripted.sent
    expect(subject.scripted.sent).toHaveLength(1)
    expect(sent?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(sent?.headers.authorization).toBe(`Bearer ${CONTRACT_JEV_KEY}`)
    expect(JSON.stringify(sent?.body)).not.toContain(CONTRACT_JEV_KEY)
    expect(Object.keys(sent?.body ?? {})).toStrictEqual(['state', 'model', 'questions'])
    expect(sent?.body.state).toStrictEqual({
      prompt: CONTRACT_ROUTE_REQUEST.prompt,
      routing_profile: CONTRACT_ROUTE_REQUEST.routingProfile
    })
    expect(sent?.body.model).toBe('jev-latest')
    expect(sent?.body.questions).toStrictEqual({
      is_trivial: {
        type: 'noul',
        instructions: IS_TRIVIAL_INSTRUCTIONS,
        criteria: IS_TRIVIAL_CRITERIA
      },
      needs_large_context: {
        type: 'noul',
        instructions: NEEDS_LARGE_CONTEXT_INSTRUCTIONS,
        criteria: NEEDS_LARGE_CONTEXT_CRITERIA
      },
      provider: {
        type: 'choice',
        instructions: PROVIDER_QUESTION_INSTRUCTIONS,
        criteria: CONTRACT_ROUTE_REQUEST.providerCriteria
      },
      model_tier: {
        type: 'choice',
        instructions: MODEL_TIER_QUESTION_INSTRUCTIONS,
        criteria: MODEL_TIER_CRITERIA
      },
      effort: { type: 'score', instructions: EFFORT_QUESTION_INSTRUCTIONS, criteria: EFFORT_RUBRIC }
    })
    expect(outcome).toStrictEqual({
      kind: 'answers',
      provider: { choice: 'claude', confidence: 0.9 },
      tier: { choice: Object.keys(MODEL_TIER_CRITERIA)[0], confidence: 0.9 },
      trivial: { probability: 0.8 },
      largeContext: { probability: 0.8 },
      effort: { score: 1 },
      usage: { inputTokens: 42 }
    })
  })

  it('[INV-88, NFR-PRIV-01] sends the second request keyed by index: one fit question per candidate and one choice, never a model id', async () => {
    const subject = subjectFor({ kind: 'answers' })
    const request: JevModelRequest = CONTRACT_MODEL_REQUEST
    const outcome = await subject.router.routeModel(request, CONTRACT_JEV_KEY)

    const [sent] = subject.scripted.sent
    expect(sent?.body.state).toStrictEqual({
      prompt: request.prompt,
      routing_profile: request.routingProfile
    })
    expect(sent?.body.questions).toStrictEqual({
      which: {
        type: 'choice',
        instructions: modelChoiceInstructions(request.tier),
        criteria: request.candidates
      },
      'fits::0': {
        type: 'noul',
        instructions: modelFitInstructions(request.tier, request.candidates['0']!)
      },
      'fits::1': {
        type: 'noul',
        instructions: modelFitInstructions(request.tier, request.candidates['1']!)
      }
    })
    expect(outcome).toStrictEqual({
      kind: 'answers',
      fits: { '0': 0.8, '1': 0.8 },
      choice: { choice: '0', probabilities: { '0': 0.9, '1': 0.1 } },
      usage: { inputTokens: 42 }
    })
  })

  it('[FM-119] refuses an answer naming a provider, tier or candidate that was never sent', async () => {
    const provider = routerOver(editedAnswers((a) => void (a.provider!.choice = 'unknown')))
    expect(await provider.router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)).toStrictEqual({
      kind: 'fallback',
      reason: 'invalid-response'
    })
    const tier = routerOver(editedAnswers((a) => void (a.model_tier!.choice = 'ultra-mega')))
    expect(await tier.router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)).toStrictEqual({
      kind: 'fallback',
      reason: 'invalid-response'
    })
    const candidate = routerOver(editedAnswers((a) => void (a.which!.choice = 'unknown')))
    expect(
      await candidate.router.routeModel(CONTRACT_MODEL_REQUEST, CONTRACT_JEV_KEY)
    ).toStrictEqual({ kind: 'fallback', reason: 'invalid-response' })
  })

  it('[FM-119] refuses a probability or score that is not a finite number in range', async () => {
    const edits: ReadonlyArray<(a: Record<string, Record<string, unknown>>) => void> = [
      (a) => void (a['fits::0']!.noul = 1.5),
      (a) => void (a['fits::1']!.noul = -0.2),
      (a) => void (a.which!.probabilities = { '0': 1.2, '1': 0.2 }),
      (a) => void delete a['fits::1']
    ]
    for (const edit of edits) {
      const { router } = routerOver(editedAnswers(edit))
      expect(await router.routeModel(CONTRACT_MODEL_REQUEST, CONTRACT_JEV_KEY)).toStrictEqual({
        kind: 'fallback',
        reason: 'invalid-response'
      })
    }
    const routeEdits: ReadonlyArray<(a: Record<string, Record<string, unknown>>) => void> = [
      (a) => void (a.is_trivial!.noul = 2),
      (a) => void (a.effort!.score = 'high'),
      (a) => void (a.provider!.confidence = null)
    ]
    for (const edit of routeEdits) {
      const { router } = routerOver(editedAnswers(edit))
      expect(await router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)).toStrictEqual({
        kind: 'fallback',
        reason: 'invalid-response'
      })
    }
  })

  it('[ADR-017, FM-119] asks TypeSafe once per attempt, never retries, and goes to its own address whatever the environment says', async () => {
    vi.stubEnv('TYPESAFE_BASE_URL', 'http://127.0.0.1:9/proxy')
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-env-key-should-not-be-used')
    for (const status of [429, 500] as const) {
      const subject = subjectFor({ kind: 'status', status })
      await subject.router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)
      expect(subject.scripted.sent, `HTTP ${status}`).toHaveLength(1)
      expect(subject.scripted.sent[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
      expect(subject.scripted.sent[0]?.headers.authorization).toBe(`Bearer ${CONTRACT_JEV_KEY}`)
    }
    const unreachable = subjectFor({ kind: 'network-error' })
    await unreachable.router.routeModel(CONTRACT_MODEL_REQUEST, CONTRACT_JEV_KEY)
    expect(unreachable.scripted.sent).toHaveLength(1)
  })

  it('[FM-119] logs jev.fallback with the reason only, once per fallback', async () => {
    const subject = subjectFor({ kind: 'status', status: 429 })
    await subject.router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)
    expect(subject.log.entries).toStrictEqual([
      {
        level: 'warn',
        event: 'jev.fallback',
        subsystem: 'jev',
        outcome: 'degraded',
        causeClass: 'rate-limited'
      }
    ])
    expect(subject.log.refused).toStrictEqual([])

    const answered = subjectFor({ kind: 'answers' })
    await answered.router.route(CONTRACT_ROUTE_REQUEST, CONTRACT_JEV_KEY)
    expect(answered.log.entries).toStrictEqual([])
  })
})
