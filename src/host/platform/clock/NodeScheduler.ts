// The production Scheduler (16 §3): one `setTimeout` per task on the Host's event loop. A task
// that throws is reported through `onTaskError` (logged by the composition root) and never
// rethrown, so it cannot stop the tasks after it. Passes runSchedulerContract.
import type { Scheduler } from '../../kernel/ports/scheduler'

export interface NodeSchedulerOptions {
  onTaskError: (error: unknown) => void
}

export class NodeScheduler implements Scheduler {
  private readonly onTaskError: (error: unknown) => void

  constructor(options: NodeSchedulerOptions) {
    this.onTaskError = options.onTaskError
  }

  after(ms: number, task: () => void): { cancel(): void } {
    const handle = setTimeout(() => {
      try {
        task()
      } catch (error) {
        this.onTaskError(error)
      }
    }, ms)
    return { cancel: () => clearTimeout(handle) }
  }
}
