import { describe, expect, it } from 'vitest'
import type { EventId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { FakeSecretReader } from '../../../kernel/fakes/FakeSecretReader'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SECRET_READ_TIMEOUT_MS } from '../../../kernel/ports/secretReader'
import type { SecretStatusChanged } from '../../preferences'
import { MODEL_CAPABILITIES } from '../domain/capabilities/modelCapability'
import type {
  JevCapabilityTable,
  JevRouteAnswers,
  RoutingModelCatalog
} from '../domain/routeDecision'
import type { RoutingProviderOption } from '../domain/routeRequest'
import { FakeJevRouter } from '../ports/fakes/FakeJevRouter'
import { JEV_ATTEMPT_TIMEOUT_MS } from '../ports/jevRouter'
import { createJevAdvisorCore, jevAdvisorErrorFor, type JevAdviceRequest } from './jevAdvisorCore'

// L2 (17 §1.2): the advisor core over FakeJevRouter and FakeSecretReader. The real capability table
// ids are the ones the transplanted domain suites use ('sonnet' balanced/medium, 'default'
// balanced/unverified).

const KEY = 'ts-advisor-test-key'
const CLAUDE: RoutingProviderOption[] = [{ provider: 'claude', installed: true, launchable: true }]
const ONE_MODEL: RoutingModelCatalog[] = [
  { provider: 'claude', models: [{ value: 'sonnet' }], efforts: [], source: 'none' }
]
const TWO_MODELS: RoutingModelCatalog[] = [
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

function request(overrides: Partial<JevAdviceRequest> = {}): JevAdviceRequest {
  return {
    purpose: 'launch',
    prompt: 'add a field to this form',
    profile: 'balanced',
    providers: CLAUDE,
    catalogs: ONE_MODEL,
    capabilities: MODEL_CAPABILITIES,
    userDefault: {},
    ...overrides
  }
}

function harness(values: { 'jev-key'?: string } = { 'jev-key': KEY }) {
  const clock = new FakeClock()
  const scheduler = new FakeScheduler(clock)
  const router = new FakeJevRouter({ scheduler, attemptTimeoutMs: JEV_ATTEMPT_TIMEOUT_MS })
  const secrets = new FakeSecretReader({ values, scheduler })
  const core = createJevAdvisorCore({ router, secrets })
  return { clock, router, secrets, core }
}

describe('jevAdvisorCore', () => {
  it('[US-LAUNCH-003.AC08, FM-119] when Jev cannot be reached the advisor returns jev-unreachable and no suggestion', async () => {
    for (const reason of ['unreachable', 'timeout', 'rate-limited', 'invalid-response'] as const) {
      const { router, core } = harness()
      router.queueResponse({ kind: 'fallback', reason })
      expect(await core.advise(request()), reason).toStrictEqual({
        ok: false,
        error: 'jev-unreachable',
        reason
      })
    }
    // A request aborted in flight (the card was dismissed or the prompt changed) leaves nothing.
    const { router, core } = harness()
    router.queueHang()
    const controller = new AbortController()
    const pending = core.advise(request({ signal: controller.signal }))
    await Promise.resolve()
    controller.abort()
    expect(await pending).toStrictEqual({ ok: false, error: 'jev-unreachable', reason: 'timeout' })
  })

  it('[US-RES-006.AC02, FM-120] an unauthorized fallback returns jev-could-not-choose with reason unauthorized, never an error of its own', async () => {
    for (const purpose of ['launch', 'subtask'] as const) {
      const { router, core } = harness()
      router.queueResponse({ kind: 'fallback', reason: 'unauthorized' })
      expect(await core.advise(request({ purpose })), purpose).toStrictEqual({
        ok: false,
        error: 'jev-could-not-choose',
        reason: 'unauthorized'
      })
      expect(router.keysSeen()).toStrictEqual([KEY])
    }
  })

  it('[US-RES-006.AC04] the key is read and TypeSafe is called only inside a suggestion; saving or clearing the key makes no router call', async () => {
    const { router, secrets, core } = harness()
    const bus = new RecordingEventBus<SecretStatusChanged>()
    for (const configured of [true, false]) {
      bus.publish({
        type: 'SecretStatusChanged',
        v: 1,
        id: `evt-${String(configured)}` as EventId,
        at: 0,
        hostEpoch: 'epoch-1',
        payload: { status: { name: 'jev-key', configured } }
      })
    }
    expect(secrets.reads).toStrictEqual([])
    expect(router.keysSeen()).toStrictEqual([])

    router.queueResponse(answers())
    const advice = await core.advise(request())
    expect(advice.ok).toBe(true)
    expect(secrets.reads).toStrictEqual(['jev-key'])
    expect(router.keysSeen()).toStrictEqual([KEY])

    // Each suggestion reads the key again: a key saved or cleared meanwhile is what the next one uses.
    router.queueResponse(answers())
    await core.advise(request())
    expect(secrets.reads).toStrictEqual(['jev-key', 'jev-key'])
  })

  it('[FM-116] a key read that times out after 10 000 ms returns jev-unreachable', async () => {
    const { clock, router, secrets, core } = harness()
    secrets.blocking = true
    const pending = core.advise(request())
    clock.advance(SECRET_READ_TIMEOUT_MS)
    expect(await pending).toStrictEqual({ ok: false, error: 'jev-unreachable', reason: 'timeout' })
    expect(router.keysSeen()).toStrictEqual([])
  })

  it('[FM-121] with no key configured the advisor returns not-configured and calls no router', async () => {
    const { router, core } = harness({})
    expect(await core.advise(request())).toStrictEqual({
      ok: false,
      error: 'not-configured',
      reason: 'no-key'
    })
    expect(router.keysSeen()).toStrictEqual([])
  })

  it('[US-LAUNCH-003.AC08] an empty launchable list asks nobody and reads no key', async () => {
    const { router, secrets, core } = harness()
    expect(await core.advise(request({ providers: [] }))).toStrictEqual({
      ok: false,
      error: 'jev-could-not-choose',
      reason: 'no-launchable-provider'
    })
    expect(secrets.reads).toStrictEqual([])
    expect(router.keysSeen()).toStrictEqual([])
  })

  it('[US-LAUNCH-003.AC08] an answered first request applies the decision; one live model asks no second request', async () => {
    const { router, core } = harness()
    router.queueResponse(answers())
    const advice = await core.advise(request())
    expect(advice).toMatchObject({
      ok: true,
      kind: 'decision',
      truncated: false,
      decision: { provider: 'claude', tier: 'balanced' },
      model: { model: 'sonnet', part: { applied: 'only-candidate' } }
    })
    expect(router.modelRequestsSeen()).toStrictEqual([])
  })

  it('[US-LAUNCH-003.AC08] two live models ask the second request with the same key and apply its winner', async () => {
    const { router, core } = harness()
    router.queueResponse(answers())
    router.queueModelResponse({
      kind: 'answers',
      fits: { '0': 0.2, '1': 0.9 },
      choice: { choice: '1', probabilities: { '0': 0.1, '1': 0.9 } },
      usage: { inputTokens: 300 }
    })
    const advice = await core.advise(request({ catalogs: TWO_MODELS }))
    expect(advice).toMatchObject({
      ok: true,
      kind: 'decision',
      model: { model: 'sonnet', part: { applied: 'answered', probability: 0.9 } }
    })
    expect(router.keysSeen()).toStrictEqual([KEY, KEY])

    // A failed second request keeps the local pick, with its reason; it is not an error.
    const failed = harness()
    failed.router.queueResponse(answers())
    failed.router.queueModelResponse({ kind: 'fallback', reason: 'unreachable' })
    expect(await failed.core.advise(request({ catalogs: TWO_MODELS }))).toMatchObject({
      ok: true,
      model: { part: { applied: 'safe-default', reason: 'unreachable' } }
    })
  })

  it('[INV-87] a request aborted during the second request leaves no suggestion', async () => {
    const { router, core } = harness()
    router.queueResponse(answers())
    router.queueModelHang()
    const controller = new AbortController()
    const pending = core.advise(request({ catalogs: TWO_MODELS, signal: controller.signal }))
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(router.modelRequestsSeen()).toHaveLength(1)
    controller.abort()
    expect(await pending).toStrictEqual({ ok: false, error: 'jev-unreachable', reason: 'timeout' })
  })

  it('[ADR-028, INV-86] with every candidate above the effort ceiling a launch keeps the fallback suggestion and a subtask cannot choose', async () => {
    const sonnet = MODEL_CAPABILITIES.claude?.sonnet
    if (sonnet === undefined) throw new Error('the capability table lost claude sonnet')
    const highOnly: JevCapabilityTable = {
      ...MODEL_CAPABILITIES,
      claude: {
        'c-xhigh': { ...sonnet, tier: 'balanced', effortLevels: ['xhigh', 'max'] },
        'c-high': { ...sonnet, tier: 'balanced', effortLevels: ['high', 'max'] }
      }
    }
    const live: RoutingModelCatalog[] = [
      {
        provider: 'claude',
        models: [{ value: 'c-xhigh' }, { value: 'c-high' }],
        efforts: [],
        source: 'provider'
      }
    ]
    const lowEffort = answers({ effort: { score: 0 } })
    const launch = harness()
    launch.router.queueResponse(lowEffort)
    expect(
      await launch.core.advise(request({ capabilities: highOnly, catalogs: live }))
    ).toStrictEqual({ ok: true, kind: 'fallback', reason: 'effort-ceiling' })

    const subtask = harness()
    subtask.router.queueResponse(lowEffort)
    expect(
      await subtask.core.advise(
        request({ purpose: 'subtask', capabilities: highOnly, catalogs: live })
      )
    ).toStrictEqual({ ok: false, error: 'jev-could-not-choose', reason: 'effort-ceiling' })
  })

  it('[US-RES-006.AC02] every fallback reason maps to the advisor error of 16 §6.4', () => {
    expect(
      Object.fromEntries(
        (
          [
            'unreachable',
            'timeout',
            'rate-limited',
            'invalid-response',
            'no-key',
            'unauthorized',
            'low-confidence',
            'budget-exceeded',
            'no-launchable-provider',
            'effort-ceiling'
          ] as const
        ).map((reason) => [reason, jevAdvisorErrorFor(reason)])
      )
    ).toStrictEqual({
      unreachable: 'jev-unreachable',
      timeout: 'jev-unreachable',
      'rate-limited': 'jev-unreachable',
      'invalid-response': 'jev-unreachable',
      'no-key': 'not-configured',
      unauthorized: 'jev-could-not-choose',
      'low-confidence': 'jev-could-not-choose',
      'budget-exceeded': 'jev-could-not-choose',
      'no-launchable-provider': 'jev-could-not-choose',
      'effort-ceiling': 'jev-could-not-choose'
    })
  })
})
