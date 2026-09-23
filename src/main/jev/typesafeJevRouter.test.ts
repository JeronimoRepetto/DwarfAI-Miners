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
import type { JevModelRouteRequest, JevRouteRequest } from './jevRouterPort'
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
} from './routeRequest'
import { classifyError, createTypesafeJevRouter, jevDebugEnabled } from './typesafeJevRouter'

/*
 * request v2 (jev-routing-profiles T3) rewrites this suite around the new
 * five-question shape. Two prior sections are REMOVED outright rather than
 * amended, both because the scenario they pinned no longer exists:
 * - `JEV_MIN_CONFIDENCE` / "degrades to the pickers below the confidence
 *   floor": the adapter no longer gates on one overall confidence — every
 *   per-question floor now resolves to a safe default in `routeDecision.ts`
 *   instead of refusing the whole call (see typesafeJevRouter.ts's own
 *   module comment).
 * - the matching "low-confidence" line in the debugLog trace tests, for the
 *   same reason.
 */

function routeRequest(overrides: Partial<JevRouteRequest> = {}): JevRouteRequest {
  return {
    prompt: 'fix the bug in the parser',
    routingProfile: 'balanced',
    truncated: false,
    providerCriteria: {
      claude: {
        what: 'Claude Code — runs as a held session this panel keeps live. Offers balanced and frontier models.',
        examples: ['Keep working on this while I watch.', 'Investigate this bug and report back.']
      },
      no_preference: {
        what: 'No requirement for a specific provider or its tooling — any capable provider works.',
        examples: ['Fix this bug.', 'Add this feature.']
      }
    },
    ...overrides
  }
}

function successBody(
  overrides: Partial<{
    providerChoice: string
    providerConfidence: number
    tierChoice: string
    tierConfidence: number
    trivialProbability: number
    largeContextProbability: number
    effortScore: number
  }> = {}
): unknown {
  const providerChoice = overrides.providerChoice ?? 'claude'
  const providerConfidence = overrides.providerConfidence ?? 0.9
  const tierChoice = overrides.tierChoice ?? 'balanced'
  const tierConfidence = overrides.tierConfidence ?? 0.85
  return {
    model: 'jev-latest-v1',
    answers: {
      is_trivial: { type: 'noul', noul: overrides.trivialProbability ?? 0.05 },
      needs_large_context: { type: 'noul', noul: overrides.largeContextProbability ?? 0.05 },
      provider: {
        type: 'choice',
        choice: providerChoice,
        confidence: providerConfidence,
        probabilities: { [providerChoice]: providerConfidence }
      },
      model_tier: {
        type: 'choice',
        choice: tierChoice,
        confidence: tierConfidence,
        probabilities: { [tierChoice]: tierConfidence }
      },
      effort: {
        type: 'score',
        score: overrides.effortScore ?? 1.5,
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
    expect(body.state).toEqual({ prompt: request.prompt, routing_profile: request.routingProfile })
    expect(body.model).toBe('jev-latest')
    const questions = body.questions as Record<string, unknown>
    expect(Object.keys(questions)).toEqual([
      'is_trivial',
      'needs_large_context',
      'provider',
      'model_tier',
      'effort'
    ])
    expect(questions.is_trivial).toEqual({
      type: 'noul',
      instructions: IS_TRIVIAL_INSTRUCTIONS,
      criteria: IS_TRIVIAL_CRITERIA
    })
    expect(questions.needs_large_context).toEqual({
      type: 'noul',
      instructions: NEEDS_LARGE_CONTEXT_INSTRUCTIONS,
      criteria: NEEDS_LARGE_CONTEXT_CRITERIA
    })
    expect(questions.provider).toEqual({
      type: 'choice',
      instructions: PROVIDER_QUESTION_INSTRUCTIONS,
      criteria: request.providerCriteria
    })
    expect(questions.model_tier).toEqual({
      type: 'choice',
      instructions: MODEL_TIER_QUESTION_INSTRUCTIONS,
      criteria: MODEL_TIER_CRITERIA
    })
    expect(questions.effort).toEqual({
      type: 'score',
      instructions: EFFORT_QUESTION_INSTRUCTIONS,
      criteria: EFFORT_RUBRIC
    })

    expect(outcome).toEqual({
      kind: 'answers',
      provider: { choice: 'claude', confidence: 0.9 },
      tier: { choice: 'balanced', confidence: 0.85 },
      trivial: { probability: 0.05 },
      largeContext: { probability: 0.05 },
      effort: { score: 1.5 },
      usage: { inputTokens: 512 }
    })
  })

  it('refuses an answer that names a provider choice this launch never sent', async () => {
    const fetchFake: typeof fetch = async () =>
      jsonResponse(successBody({ providerChoice: 'unknown-provider' }))
    const router = createTypesafeJevRouter({ readKey: () => 'sk-test', fetch: fetchFake })

    const outcome = await router.route(routeRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'invalid-response' })
  })

  it('refuses an answer that names a tier this app never offered', async () => {
    const fetchFake: typeof fetch = async () =>
      jsonResponse(successBody({ tierChoice: 'ultra-mega' }))
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
 * #608's second request: one Noul per candidate ('fits::<index>') plus one
 * Choice ('which') over the same candidates, keyed by index — never by a
 * candidate's own model id. Mirrors the shape and idioms of the `route`
 * suite above: real jsonResponse/hangingFetch fakes, no vi.mock (skills/tdd).
 */
describe('createTypesafeJevRouter — routeModel (#608)', () => {
  function modelRouteRequest(overrides: Partial<JevModelRouteRequest> = {}): JevModelRouteRequest {
    return {
      prompt: 'add a field to this form',
      routingProfile: 'balanced',
      truncated: false,
      tier: 'balanced',
      candidates: {
        '0': {
          what: 'A quick, cheap model.',
          not_for: 'Hard work.',
          examples: ['a', 'b'],
          tier: 'balanced',
          relativeCost: 'low'
        },
        '1': {
          what: 'A pricier, deeper model.',
          not_for: 'Trivial work.',
          examples: ['c', 'd'],
          tier: 'balanced',
          relativeCost: 'high'
        }
      },
      ...overrides
    }
  }

  function modelSuccessBody(
    overrides: Partial<{
      choice: string
      fits: Record<string, number>
      probabilities: Record<string, number>
    }> = {}
  ): unknown {
    const choiceKey = overrides.choice ?? '0'
    return {
      model: 'jev-latest-v1',
      answers: {
        which: {
          type: 'choice',
          choice: choiceKey,
          confidence: 0.8,
          probabilities: overrides.probabilities ?? { '0': 0.8, '1': 0.2 }
        },
        'fits::0': { type: 'noul', noul: overrides.fits?.['0'] ?? 0.9 },
        'fits::1': { type: 'noul', noul: overrides.fits?.['1'] ?? 0.3 }
      },
      usage: { input_tokens: 700, output_tokens: 20 }
    }
  }

  it('never calls fetch when no key is configured', async () => {
    const fetchSpy = vi.fn()
    const router = createTypesafeJevRouter({
      readKey: () => undefined,
      fetch: fetchSpy as unknown as typeof fetch
    })

    const outcome = await router.routeModel(modelRouteRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'no-key' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends one Noul per candidate keyed by index, plus one Choice over the same candidates — never a model id', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchFake: typeof fetch = async (input, init) => {
      captured = { url: String(input), init: init ?? {} }
      return jsonResponse(modelSuccessBody())
    }
    const router = createTypesafeJevRouter({ readKey: () => 'sk-test', fetch: fetchFake })
    const request = modelRouteRequest()

    const outcome = await router.routeModel(request, {})

    expect(captured?.url).toBe('https://api.typesafe.ai/v1/systemone')
    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>
    expect(body.state).toEqual({ prompt: request.prompt, routing_profile: request.routingProfile })
    const questions = body.questions as Record<string, unknown>
    expect(Object.keys(questions).sort()).toEqual(['fits::0', 'fits::1', 'which'].sort())
    expect(questions.which).toEqual({
      type: 'choice',
      instructions: modelChoiceInstructions(request.tier),
      criteria: request.candidates
    })
    expect(questions['fits::0']).toEqual({
      type: 'noul',
      instructions: modelFitInstructions(request.tier, request.candidates['0']!)
    })
    expect(questions['fits::1']).toEqual({
      type: 'noul',
      instructions: modelFitInstructions(request.tier, request.candidates['1']!)
    })
    expect(JSON.stringify(body)).not.toMatch(/sonnet|gpt-5|claude-|codex-/)

    expect(outcome).toEqual({
      kind: 'answers',
      fits: { '0': 0.9, '1': 0.3 },
      choice: { choice: '0', probabilities: { '0': 0.8, '1': 0.2 } },
      usage: { inputTokens: 700 }
    })
  })

  it('refuses an answer whose Choice names a candidate this request never sent', async () => {
    const fetchFake: typeof fetch = async () =>
      jsonResponse(modelSuccessBody({ choice: 'unknown' }))
    const router = createTypesafeJevRouter({ readKey: () => 'sk-test', fetch: fetchFake })

    const outcome = await router.routeModel(modelRouteRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'invalid-response' })
  })

  it('reads a 401 as unauthorized end to end, without retrying', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401))
    const router = createTypesafeJevRouter({ readKey: () => 'sk-bad', fetch: fetchSpy })

    const outcome = await router.routeModel(modelRouteRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'unauthorized' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('reads a caller abort as timeout end to end, without retrying', async () => {
    const router = createTypesafeJevRouter({ readKey: () => 'sk-test', fetch: hangingFetch() })
    const controller = new AbortController()
    controller.abort()

    const outcome = await router.routeModel(modelRouteRequest(), { signal: controller.signal })

    expect(outcome).toEqual({ kind: 'fallback', reason: 'timeout' })
  })

  it('traces a request and answers block through the same debugLog sink, keeping the key out of every line', async () => {
    const lines: string[] = []
    const router = createTypesafeJevRouter({
      readKey: () => 'sk-secret-test-key',
      fetch: async () => jsonResponse(modelSuccessBody()),
      debugLog: (line) => lines.push(line)
    })

    await router.routeModel(modelRouteRequest(), {})

    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('[jev:debug] request →')
    expect(lines[2]).toBe('[jev:debug] answers ←')
    for (const line of lines) {
      expect(line).not.toContain('sk-secret-test-key')
    }
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

/*
 * The #525 dev-console trace. `debugLog` is the ONLY output channel the router
 * gains — SILENT_LOGGER and logLevel 'off' stay exactly as they are, because
 * the SDK's own debug mode dumps request bodies unredacted and this trace says
 * only what the three lines below say. The no-sink case is pinned by
 * construction (identical outcomes; without the option there is nothing to
 * emit into): this file has never spied on the console and inventing that
 * idiom for an unobservable absence would prove nothing anyway.
 *
 * AMENDED for jev-routing-profiles T4: a single greppable line per event is
 * REPLACED by a header line (still single-line and greppable on its own —
 * `grep '\[jev:debug\]'` still finds one per event) followed by that event's
 * payload PRETTY-PRINTED (`JSON.stringify(value, null, 2)`), because the
 * whole point of T4 is a trace a person can actually read on the dev console
 * rather than one packed line per call. This is why the old "one line each,
 * never a raw newline" assertion is gone rather than amended — the thing it
 * was pinning is exactly what T4 asked to change — and every assertion below
 * that read a slice off the front of a combined line now reads the payload
 * line on its own instead.
 */
describe('the debugLog trace (#525, jev-routing-profiles T4)', () => {
  const REQUEST_HEADER = '[jev:debug] request →'
  const ANSWERS_HEADER = '[jev:debug] answers ←'
  const FALLBACK_HEADER = '[jev:debug] fallback'

  function tracingRouter(
    fetchFake: typeof fetch,
    readKey: () => string | undefined = () => 'sk-test'
  ): { lines: string[]; router: ReturnType<typeof createTypesafeJevRouter> } {
    const lines: string[] = []
    const router = createTypesafeJevRouter({
      readKey,
      fetch: fetchFake,
      debugLog: (line) => lines.push(line)
    })
    return { lines, router }
  }

  it('logs a request block and an answers block for a successful call, showing the full request and the full answers', async () => {
    const request = routeRequest()
    const { lines, router } = tracingRouter(async () => jsonResponse(successBody()))

    const outcome = await router.route(request, {})

    expect(outcome).toMatchObject({
      kind: 'answers',
      provider: { choice: 'claude', confidence: 0.9 },
      tier: { choice: 'balanced', confidence: 0.85 }
    })
    // Header, payload, header, payload — two debugLog calls per event.
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe(REQUEST_HEADER)
    expect(lines[2]).toBe(ANSWERS_HEADER)

    const requestPayload = JSON.parse(lines[1]!) as Record<string, unknown>
    expect(requestPayload.state).toEqual({
      prompt: request.prompt,
      routing_profile: request.routingProfile
    })
    expect(requestPayload.truncated).toBe(false)
    expect(Object.keys(requestPayload.questions as object)).toEqual([
      'is_trivial',
      'needs_large_context',
      'provider',
      'model_tier',
      'effort'
    ])

    const answerPayload = JSON.parse(lines[3]!) as Record<string, unknown>
    // The FULL answers, probabilities included — never just the fields the
    // typed outcome above carries forward.
    expect(answerPayload.provider).toEqual({
      type: 'choice',
      choice: 'claude',
      confidence: 0.9,
      probabilities: { claude: 0.9 }
    })
    expect(answerPayload.is_trivial).toEqual({ type: 'noul', noul: 0.05 })
    expect(answerPayload.inputTokens).toBe(512)
  })

  it('marks a truncated prompt as truncated in the request block', async () => {
    const { lines, router } = tracingRouter(async () => jsonResponse(successBody()))

    await router.route(routeRequest({ prompt: 'a trimmed prompt', truncated: true }), {})

    const payload = JSON.parse(lines[1]!) as Record<string, unknown>
    expect((payload.state as Record<string, unknown>).prompt).toBe('a trimmed prompt')
    expect(payload.truncated).toBe(true)
  })

  it('logs invalid-response when the answer names a provider choice this launch never sent', async () => {
    const { lines, router } = tracingRouter(async () =>
      jsonResponse(successBody({ providerChoice: 'unknown-provider' }))
    )

    const outcome = await router.route(routeRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'invalid-response' })
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe(REQUEST_HEADER)
    expect(lines[2]).toBe(FALLBACK_HEADER)
    expect(JSON.parse(lines[3]!)).toEqual({
      reason: 'invalid-response',
      elapsedMs: expect.any(Number)
    })
  })

  it('logs the classified reason when the fetch itself throws', async () => {
    // A plain throw is the honest case: the SDK's own attempt() wraps ANY
    // non-abort fetch error into an APIConnectionError (dist/index.mjs) —
    // an error TYPE thrown from here would not survive the wrap, so the
    // end-to-end reason is 'unreachable', paid through one real SDK backoff.
    // The direct classification of each SDK type stays pinned by the
    // classifyError suite above, where it costs no timer at all.
    const { lines, router } = tracingRouter(async () => {
      throw new Error('connection reset')
    })

    const outcome = await router.route(routeRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'unreachable' })
    expect(lines).toHaveLength(4)
    expect(lines[2]).toBe(FALLBACK_HEADER)
    const payload = JSON.parse(lines[3]!) as Record<string, unknown>
    expect(payload.reason).toBe('unreachable')
    expect(typeof payload.elapsedMs).toBe('number')
  })

  it('logs nothing for a route that never got as far as a key', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(successBody()))
    const { lines, router } = tracingRouter(fetchSpy, () => undefined)

    const outcome = await router.route(routeRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'no-key' })
    expect(lines).toEqual([])
  })

  it('keeps the API key out of every line, on every path', async () => {
    const lines: string[] = []
    const responses: (() => Response | Promise<Response>)[] = [
      () => jsonResponse(successBody()),
      () => jsonResponse(successBody({ providerChoice: 'unknown-provider' })),
      async () => {
        throw new Error('connection reset')
      }
    ]
    let call = 0
    const router = createTypesafeJevRouter({
      readKey: () => 'sk-secret-test-key',
      fetch: async () => responses[call++]!(),
      debugLog: (line) => lines.push(line)
    })

    for (let i = 0; i < responses.length; i += 1) {
      await router.route(routeRequest(), {})
    }

    // Three calls, four lines each (header+payload per event, two events per call).
    expect(lines).toHaveLength(12)
    for (const line of lines) {
      expect(line).not.toContain('sk-secret-test-key')
    }
  })

  it('behaves identically with no debugLog sink', async () => {
    const router = createTypesafeJevRouter({
      readKey: () => 'sk-test',
      fetch: async () => jsonResponse(successBody())
    })
    const fallbackRouter = createTypesafeJevRouter({
      readKey: () => 'sk-test',
      fetch: async () => jsonResponse(successBody({ providerChoice: 'unknown-provider' }))
    })

    expect(await router.route(routeRequest(), {})).toMatchObject({
      kind: 'answers',
      provider: { choice: 'claude', confidence: 0.9 }
    })
    expect(await fallbackRouter.route(routeRequest(), {})).toEqual({
      kind: 'fallback',
      reason: 'invalid-response'
    })
  })
})

/*
 * The switch that decides whether index.ts wires a sink at all. Parsing lives
 * here rather than inline in index.ts so it is testable without Electron, and
 * it mirrors config.ts's readFlag exactly — `1`/`true` (trimmed,
 * case-insensitive) on, and blank, `0`, `false` and junk all off — which is
 * also what docs/guide.md's Diagnostic switches section promises. The
 * `env = process.env` default is the one line this suite cannot exercise
 * without mutating the real environment, so it is left to the parameter the
 * loop passes.
 */
describe('jevDebugEnabled (#525)', () => {
  it('is on for exactly 1 and true, trimmed and case-insensitive', () => {
    for (const value of ['1', 'true', 'TRUE', ' True ', '1 ']) {
      expect(jevDebugEnabled({ JEV_DEBUG: value })).toBe(true)
    }
  })

  it('treats absence, blank, 0, false and junk as off', () => {
    for (const value of ['', '   ', '0', 'false', 'no', 'yes', '0 ']) {
      expect(jevDebugEnabled({ JEV_DEBUG: value })).toBe(false)
    }
    expect(jevDebugEnabled({})).toBe(false)
  })
})
