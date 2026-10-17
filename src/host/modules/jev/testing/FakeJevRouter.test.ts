import { describe } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { runJevRouterContract, type JevRouterScript } from './jevRouter.contract'
import { FakeJevRouter } from '../ports/fakes/FakeJevRouter'
import {
  JEV_ATTEMPT_TIMEOUT_MS,
  type JevModelResponse,
  type JevRouteResponse
} from '../ports/jevRouter'

const ROUTE_ANSWERS: JevRouteResponse = {
  kind: 'answers',
  provider: { choice: 'claude', confidence: 0.9 },
  tier: { choice: 'balanced', confidence: 0.9 },
  trivial: { probability: 0.2 },
  largeContext: { probability: 0.1 },
  effort: { score: 1 },
  usage: { inputTokens: 42 }
}

const MODEL_ANSWERS: JevModelResponse = {
  kind: 'answers',
  fits: { '0': 0.8, '1': 0.6 },
  choice: { choice: '0', probabilities: { '0': 0.9, '1': 0.1 } },
  usage: { inputTokens: 42 }
}

/** What the scripted double answers for each script: the reason the real adapter maps it to. */
function scriptFake(fake: FakeJevRouter, script: JevRouterScript): void {
  const fallback = (
    reason: 'unauthorized' | 'rate-limited' | 'unreachable' | 'invalid-response'
  ) => {
    fake.queueResponse({ kind: 'fallback', reason })
    fake.queueModelResponse({ kind: 'fallback', reason })
  }
  switch (script.kind) {
    case 'answers':
      fake.queueResponse(ROUTE_ANSWERS)
      fake.queueModelResponse(MODEL_ANSWERS)
      return
    case 'status':
      if (script.status === 429) fallback('rate-limited')
      else if (script.status === 500) fallback('unreachable')
      else fallback('unauthorized')
      return
    case 'network-error':
      fallback('unreachable')
      return
    case 'invalid-body':
      fallback('invalid-response')
      return
    case 'hang':
      fake.queueHang()
      fake.queueModelHang()
  }
}

// L3 (17 §1.3): the double runs the same contract as `TypesafeJevRouter`.
describe('FakeJevRouter', () => {
  runJevRouterContract((script) => {
    const clock = new FakeClock()
    const fake = new FakeJevRouter({
      scheduler: new FakeScheduler(clock),
      attemptTimeoutMs: JEV_ATTEMPT_TIMEOUT_MS
    })
    scriptFake(fake, script)
    return { router: fake, clock, requestsSent: () => fake.keysSeen().length }
  })
})
