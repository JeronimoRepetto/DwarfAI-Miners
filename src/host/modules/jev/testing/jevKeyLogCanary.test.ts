import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANARY_CORPUS } from '../../../../contracts/logging/testing/canaryCorpus'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { scriptedTypesafeFetch } from '../adapters/typesafe/testing/scriptedTypesafeFetch'
import { TypesafeJevRouter } from '../adapters/typesafe/TypesafeJevRouter'
import type { JevModelRequest, JevRouteRequest } from '../ports/jevRouter'
import {
  CONTRACT_MODEL_REQUEST,
  CONTRACT_ROUTE_REQUEST,
  type JevRouterScript
} from './jevRouter.contract'

// L7 log canary (17 §1.7; NFR-SEC-12; ADR-017 item 3): every path of `TypesafeJevRouter` is run
// with the canary corpus's credential-shaped values and a live fake key as the Jev key, and the
// canary prompt as the prompt. Lives under `testing/` because adapters never import contracts (R9).

function subjectFor(script: JevRouterScript) {
  const clock = new FakeClock()
  const log = new RecordingDiagnosticsLog()
  const scripted = scriptedTypesafeFetch(script)
  const router = new TypesafeJevRouter({
    scheduler: new FakeScheduler(clock),
    log,
    fetch: scripted.fetch
  })
  return { router, clock, log }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Jev key log canary', () => {
  it('[NFR-SEC-12] the Jev key never appears in a log record or an error', async () => {
    const console = (['debug', 'info', 'log', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(globalThis.console, method).mockImplementation(() => {})
    )
    const credentials = CANARY_CORPUS.filter((c) => c.class === 'credential').map((c) => c.value)
    const prompt = CANARY_CORPUS.find((c) => c.kind === 'prompt')!.value
    const keys = [...credentials, 'ts-live-fake-key-7f3a9c']
    const scripts: JevRouterScript[] = [
      { kind: 'answers' },
      { kind: 'status', status: 401 },
      { kind: 'status', status: 403 },
      { kind: 'status', status: 429 },
      { kind: 'status', status: 500 },
      { kind: 'network-error' },
      { kind: 'invalid-body' },
      { kind: 'hang' }
    ]
    const route: JevRouteRequest = { ...CONTRACT_ROUTE_REQUEST, prompt }
    const model: JevModelRequest = { ...CONTRACT_MODEL_REQUEST, prompt }
    const seen: unknown[] = []
    for (const key of keys) {
      for (const script of scripts) {
        const subject = subjectFor(script)
        const asked = [
          subject.router.route(route, key),
          subject.router.routeModel(model, key, { signal: AbortSignal.abort() })
        ]
        subject.clock.advance(8_000)
        seen.push(...(await Promise.all(asked)), subject.log.entries, subject.log.refused)
      }
    }
    const written = JSON.stringify(seen) + JSON.stringify(console.map((spy) => spy.mock.calls))
    for (const key of keys) expect(written).not.toContain(key)
    expect(written).not.toContain(prompt)
    for (const spy of console) expect(spy).not.toHaveBeenCalled()
  })
})
