// The SubtaskRouter double (16 §4.8 `FakeSubtaskRouter`). A test queues the answers it wants, in
// call order, and reads back every task and context the code under test routed: zero calls proves
// nothing reached Jev (ADR-013 item 4, C-26). A call with nothing queued, or a queued `'reject'`,
// rejects, so a gap in a test's own setup is loud. Never imported by production code (R14).
import type { Result } from '../../../../kernel/domain/values'
import type { JevSuggestionView, SubtaskRouter } from '../subtaskRouting'

type RouteAnswer = Result<JevSuggestionView, 'jev-unreachable' | 'jev-could-not-choose'>

/** One `route` call as the double received it. */
export interface RoutedSubtask {
  task: string
  context?: string
}

export class FakeSubtaskRouter implements SubtaskRouter {
  readonly calls: RoutedSubtask[] = []
  private readonly answers: (RouteAnswer | 'reject')[] = []

  /** Queues the next answer `route` resolves with (or `'reject'`: the call rejects). */
  queue(answer: RouteAnswer | 'reject'): void {
    this.answers.push(answer)
  }

  route(task: string, context?: string): Promise<RouteAnswer> {
    this.calls.push(context === undefined ? { task } : { task, context })
    const next = this.answers.shift()
    if (next === undefined) {
      return Promise.reject(new Error('FakeSubtaskRouter: route() called with no answer queued'))
    }
    if (next === 'reject') return Promise.reject(new Error('FakeSubtaskRouter: rejected'))
    return Promise.resolve(next)
  }
}
