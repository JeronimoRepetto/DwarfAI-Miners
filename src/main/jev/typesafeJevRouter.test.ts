import {
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError
} from '@typesafe-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { JevRouteRequest } from './jevRouterPort'
import {
  EFFORT_QUESTION_INSTRUCTIONS,
  EFFORT_RUBRIC,
  MODEL_QUESTION_INSTRUCTIONS,
  mapEffortScore
} from './routeRequest'
import { JEV_MIN_CONFIDENCE, classifyError, createTypesafeJevRouter } from './typesafeJevRouter'

function routeRequest(overrides: Partial<JevRouteRequest> = {}): JevRouteRequest {
  return {
    state: 'fix the bug in the parser',
    truncated: false,
    modelChoices: [
      {
        key: 'claude:sonnet-4.5',
        provider: 'claude',
        model: 'sonnet-4.5',
        criteria: 'Claude Code, running the "sonnet-4.5" model.'
      }
    ],
    ...overrides
  }
}

function successBody(
  overrides: Partial<{
    choice: string
    modelConfidence: number
    score: number
  }> = {}
): unknown {
  return {
    model: 'jev-latest-v1',
    answers: {
      model: {
        type: 'choice',
        choice: overrides.choice ?? 'claude:sonnet-4.5',
        confidence: overrides.modelConfidence ?? 0.9,
        probabilities: {
          [overrides.choice ?? 'claude:sonnet-4.5']: overrides.modelConfidence ?? 0.9
        }
      },
      effort: {
        type: 'score',
        score: overrides.score ?? 1.5,
        legend: { 0: 'trivial', 1: 'small', 2: 'multi-file', 3: 'architectural' },
        probabilities: { 0: 0.1, 1: 0.6, 2: 0.2, 3: 0.1 }
      }
    },
    usage: { input_tokens: 512, output_tokens: 12 }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** A real fetch never resolves an already-aborted or later-aborted request. */
function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
      if (init?.signal?.aborted) {
        abort()
        return
      }
      init?.signal?.addEventListener('abort', abort)
    })
}

describe('createTypesafeJevRouter', () => {
  it('never calls fetch when no key is configured', async () => {
    const fetchSpy = vi.fn()
    const router = createTypesafeJevRouter({
      readKey: () => undefined,
      fetch: fetchSpy as unknown as typeof fetch
    })

    const outcome = await router.route(routeRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'no-key' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends the exact request TypeSafe documents, and nothing about this machine but the prompt', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchFake: typeof fetch = async (input, init) => {
      captured = { url: String(input), init: init ?? {} }
      return jsonResponse(successBody())
    }
    const router = createTypesafeJevRouter({ readKey: () => 'sk-test', fetch: fetchFake })
    const request = routeRequest()

    const outcome = await router.route(request, {})

    expect(captured?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['state', 'model', 'questions'])
    expect(body.state).toBe(request.state)
    expect(body.model).toBe('jev-latest')
    expect(body.questions).toEqual({
      model: {
        type: 'choice',
        instructions: MODEL_QUESTION_INSTRUCTIONS,
        criteria: { 'claude:sonnet-4.5': request.modelChoices[0]!.criteria }
      },
      effort: {
        type: 'score',
        instructions: EFFORT_QUESTION_INSTRUCTIONS,
        criteria: EFFORT_RUBRIC
      }
    })

    const expectedEffort = mapEffortScore('claude', 1.5, {
      claude: ['low', 'medium', 'high', 'xhigh', 'max'],
      codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      antigravity: ['low', 'medium', 'high'],
      opencode: []
    })
    expect(outcome).toEqual({
      kind: 'decision',
      provider: 'claude',
      model: 'sonnet-4.5',
      effort: expectedEffort,
      confidence: 0.9,
      usage: { inputTokens: 512 }
    })
  })

  it('degrades to the pickers below the confidence floor, keeping the confidence for display', async () => {
    const belowFloor = JEV_MIN_CONFIDENCE - 0.1
    const fetchFake: typeof fetch = async () =>
      jsonResponse(successBody({ modelConfidence: belowFloor }))
    const router = createTypesafeJevRouter({ readKey: () => 'sk-test', fetch: fetchFake })

    const outcome = await router.route(routeRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'low-confidence', confidence: belowFloor })
  })

  it('refuses an answer that names a choice this launch never sent', async () => {
    const fetchFake: typeof fetch = async () =>
      jsonResponse(successBody({ choice: 'codex:unknown-model' }))
    const router = createTypesafeJevRouter({ readKey: () => 'sk-test', fetch: fetchFake })

    const outcome = await router.route(routeRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'invalid-response' })
  })

  it('reads a 401 as unauthorized end to end, without retrying', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401))
    const router = createTypesafeJevRouter({ readKey: () => 'sk-bad', fetch: fetchSpy })

    const outcome = await router.route(routeRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'unauthorized' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('reads a caller abort as timeout end to end, without retrying', async () => {
    const router = createTypesafeJevRouter({ readKey: () => 'sk-test', fetch: hangingFetch() })
    const controller = new AbortController()
    controller.abort()

    const outcome = await router.route(routeRequest(), { signal: controller.signal })

    expect(outcome).toEqual({ kind: 'fallback', reason: 'timeout' })
  })
})

/*
 * classifyError direct against constructed SDK errors, rather than through a
 * live retry loop: 429, 5xx, connection failures and the SDK's own timeout
 * are all RETRYABLE under the client's default retry policy, and the SDK
 * owns that timer — not injectable here — so driving them through route()
 * would pay one real backoff wait per case. Constructing the error directly
 * proves the same mapping without a real timer in this suite (see
 * skills/tdd/SKILL.md: "no real timer in a unit test").
 */
describe('classifyError', () => {
  const headers = new Headers()

  it('maps AuthenticationError (401) to unauthorized', () => {
    expect(classifyError(new AuthenticationError(401, undefined, headers))).toBe('unauthorized')
  })

  it('maps RateLimitError (429) to rate-limited', () => {
    expect(classifyError(new RateLimitError(429, undefined, headers))).toBe('rate-limited')
  })

  it('maps APIUserAbortError to timeout', () => {
    expect(classifyError(new APIUserAbortError())).toBe('timeout')
  })

  it('maps APITimeoutError to timeout, not the unreachable its own parent class would give', () => {
    expect(classifyError(new APITimeoutError(8000))).toBe('timeout')
  })

  it('maps a bare APIConnectionError to unreachable', () => {
    expect(classifyError(new APIConnectionError())).toBe('unreachable')
  })

  it('maps InternalServerError (5xx, and 529) to unreachable', () => {
    expect(classifyError(new InternalServerError(503, undefined, headers))).toBe('unreachable')
    expect(classifyError(new InternalServerError(529, undefined, headers))).toBe('unreachable')
  })

  it('maps anything else to invalid-response', () => {
    expect(classifyError(new BadRequestError(400, undefined, headers))).toBe('invalid-response')
    expect(classifyError(new Error('boom'))).toBe('invalid-response')
  })
})
