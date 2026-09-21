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
import {
  JEV_MIN_CONFIDENCE,
  classifyError,
  createTypesafeJevRouter,
  jevDebugEnabled
} from './typesafeJevRouter'

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

/*
 * The #525 dev-console trace. `debugLog` is the ONLY output channel the router
 * gains — SILENT_LOGGER and logLevel 'off' stay exactly as they are, because
 * the SDK's own debug mode dumps request bodies unredacted and this trace says
 * only what the three lines below say. The no-sink case is pinned by
 * construction (identical outcomes; without the option there is nothing to
 * emit into): this file has never spied on the console and inventing that
 * idiom for an unobservable absence would prove nothing anyway.
 */
describe('the debugLog trace (#525)', () => {
  const REQUEST_PREFIX = '[jev:debug] request '
  const ANSWER_PREFIX = '[jev:debug] answer '
  const FALLBACK_PREFIX = '[jev:debug] fallback '

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

  it('logs exactly a request line and an answer line for a routed decision', async () => {
    const request = routeRequest()
    const { lines, router } = tracingRouter(async () => jsonResponse(successBody()))

    const outcome = await router.route(request, {})

    expect(outcome).toMatchObject({ kind: 'decision', provider: 'claude', confidence: 0.9 })
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      // "one line each" is what makes the trace greppable — a payload that
      // smuggled a raw newline would break `grep '\[jev:debug\]' | wc -l`.
      expect(line).not.toContain('\n')
    }
    expect(lines[0]!.startsWith(REQUEST_PREFIX)).toBe(true)
    expect(JSON.parse(lines[0]!.slice(REQUEST_PREFIX.length))).toEqual({
      state: request.state,
      truncated: false,
      choices: { [request.modelChoices[0]!.key]: request.modelChoices[0]!.criteria }
    })
    expect(lines[1]!.startsWith(ANSWER_PREFIX)).toBe(true)
    expect(JSON.parse(lines[1]!.slice(ANSWER_PREFIX.length))).toEqual({
      choice: 'claude:sonnet-4.5',
      confidence: 0.9,
      effortScore: 1.5,
      inputTokens: 512
    })
  })

  it('marks a truncated state as truncated in the request line', async () => {
    const { lines, router } = tracingRouter(async () => jsonResponse(successBody()))

    await router.route(routeRequest({ state: 'a trimmed prompt', truncated: true }), {})

    const payload = JSON.parse(lines[0]!.slice(REQUEST_PREFIX.length)) as Record<string, unknown>
    expect(payload.state).toBe('a trimmed prompt')
    expect(payload.truncated).toBe(true)
  })

  it('logs the reason, the confidence and the elapsed time on a low-confidence fallback', async () => {
    const belowFloor = JEV_MIN_CONFIDENCE - 0.1
    const { lines, router } = tracingRouter(async () =>
      jsonResponse(successBody({ modelConfidence: belowFloor }))
    )

    const outcome = await router.route(routeRequest(), {})

    // The trace changes no behavior: the exact outcome the pre-#525 router
    // returned is still the exact outcome returned here.
    expect(outcome).toEqual({ kind: 'fallback', reason: 'low-confidence', confidence: belowFloor })
    expect(lines).toHaveLength(2)
    expect(lines[0]!.startsWith(REQUEST_PREFIX)).toBe(true)
    expect(lines[1]!.startsWith(FALLBACK_PREFIX)).toBe(true)
    const payload = JSON.parse(lines[1]!.slice(FALLBACK_PREFIX.length)) as Record<string, unknown>
    expect(payload.reason).toBe('low-confidence')
    expect(payload.confidence).toBe(belowFloor)
    expect(typeof payload.elapsedMs).toBe('number')
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('logs invalid-response when the answer names a choice this launch never sent', async () => {
    const { lines, router } = tracingRouter(async () =>
      jsonResponse(successBody({ choice: 'codex:unknown-model' }))
    )

    const outcome = await router.route(routeRequest(), {})

    expect(outcome).toEqual({ kind: 'fallback', reason: 'invalid-response' })
    expect(lines).toHaveLength(2)
    expect(lines[1]!.startsWith(FALLBACK_PREFIX)).toBe(true)
    expect(JSON.parse(lines[1]!.slice(FALLBACK_PREFIX.length))).toEqual({
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
    expect(lines).toHaveLength(2)
    expect(lines[1]!.startsWith(FALLBACK_PREFIX)).toBe(true)
    const payload = JSON.parse(lines[1]!.slice(FALLBACK_PREFIX.length)) as Record<string, unknown>
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
    const belowFloor = JEV_MIN_CONFIDENCE - 0.1
    const responses: (() => Response | Promise<Response>)[] = [
      () => jsonResponse(successBody()),
      () => jsonResponse(successBody({ modelConfidence: belowFloor })),
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

    expect(lines).toHaveLength(6)
    for (const line of lines) {
      expect(line).not.toContain('sk-secret-test-key')
    }
  })

  it('behaves identically with no debugLog sink', async () => {
    const router = createTypesafeJevRouter({
      readKey: () => 'sk-test',
      fetch: async () => jsonResponse(successBody())
    })
    const belowFloor = JEV_MIN_CONFIDENCE - 0.1
    const fallbackRouter = createTypesafeJevRouter({
      readKey: () => 'sk-test',
      fetch: async () => jsonResponse(successBody({ modelConfidence: belowFloor }))
    })

    expect(await router.route(routeRequest(), {})).toMatchObject({
      kind: 'decision',
      provider: 'claude',
      confidence: 0.9
    })
    expect(await fallbackRouter.route(routeRequest(), {})).toEqual({
      kind: 'fallback',
      reason: 'low-confidence',
      confidence: belowFloor
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
