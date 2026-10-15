// The scripted `JevRouter` double (16 §4.9 "FakeJevRouter (transplanted)"; 16 §2.8), from the
// found tree's `src/main/jev/fakeJevRouter.ts`: no network, no SDK. A test queues exactly the
// answers and fallbacks it wants, and reads back every request and key the code under test sent.
// Test-only: production code never imports it (R14).
import type { SecretValue } from '../../../../kernel/ports/secretReader'
import type {
  JevModelRequest,
  JevModelResponse,
  JevRouteRequest,
  JevRouteResponse,
  JevRouter
} from '../jevRouter'

/** One call the fake received: the request and the key it was sent with. */
export interface JevRouterCall<R> {
  request: R
  key: SecretValue
}

export class FakeJevRouter implements JevRouter {
  private readonly responses: JevRouteResponse[] = []
  private readonly modelResponses: JevModelResponse[] = []
  private readonly calls: JevRouterCall<JevRouteRequest>[] = []
  private readonly modelCalls: JevRouterCall<JevModelRequest>[] = []

  /** Queues the next response `route` returns, in call order. */
  queueResponse(response: JevRouteResponse): void {
    this.responses.push(response)
  }

  /** Queues the next response `routeModel` returns, in call order. */
  queueModelResponse(response: JevModelResponse): void {
    this.modelResponses.push(response)
  }

  /** Every request `route` was called with, in call order. */
  requestsSeen(): readonly JevRouteRequest[] {
    return this.calls.map((call) => call.request)
  }

  /** Every request `routeModel` was called with, in call order. */
  modelRequestsSeen(): readonly JevModelRequest[] {
    return this.modelCalls.map((call) => call.request)
  }

  /** Every key either request was sent with, in call order (first requests, then second). */
  keysSeen(): readonly SecretValue[] {
    return [...this.calls, ...this.modelCalls].map((call) => call.key)
  }

  async route(req: JevRouteRequest, key: SecretValue): Promise<JevRouteResponse> {
    this.calls.push({ request: req, key })
    const next = this.responses.shift()
    // Loud rather than a silent default: a test that queued nothing has a gap in its own setup,
    // not a real fallback to report (the port itself never throws, 16 §6.3).
    if (next === undefined) throw new Error('FakeJevRouter: route() called with no response queued')
    return next
  }

  async routeModel(req: JevModelRequest, key: SecretValue): Promise<JevModelResponse> {
    this.modelCalls.push({ request: req, key })
    const next = this.modelResponses.shift()
    if (next === undefined) {
      throw new Error('FakeJevRouter: routeModel() called with no response queued')
    }
    return next
  }
}
