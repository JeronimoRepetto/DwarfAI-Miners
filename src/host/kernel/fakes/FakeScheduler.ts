// The Scheduler double (16 §3): advances with its FakeClock and runs due tasks in order —
// by due instant, then by the order they were scheduled. Passes runSchedulerContract.
import type { Instant } from '../domain/values'
import type { Scheduler } from '../ports/scheduler'
import type { ClockDriven, FakeClock } from './FakeClock'

export interface FakeSchedulerOptions {
  /** Where a throwing task is reported; by default it is kept in `taskErrors`. */
  onTaskError?: (error: unknown) => void
}

interface PendingTask {
  dueAt: Instant
  seq: number
  task: () => void
}

export class FakeScheduler implements Scheduler, ClockDriven {
  /** Errors thrown by tasks, when no `onTaskError` was given. */
  readonly taskErrors: unknown[] = []
  private readonly pending: PendingTask[] = []
  private nextSeq = 0
  private readonly onTaskError: (error: unknown) => void

  constructor(
    private readonly clock: FakeClock,
    options: FakeSchedulerOptions = {}
  ) {
    this.onTaskError = options.onTaskError ?? ((error) => this.taskErrors.push(error))
    clock.attach(this)
  }

  after(ms: number, task: () => void): { cancel(): void } {
    const entry: PendingTask = {
      dueAt: this.clock.now() + Math.max(0, ms),
      seq: this.nextSeq++,
      task
    }
    this.pending.push(entry)
    return { cancel: () => this.remove(entry) }
  }

  nextDueAt(): Instant | null {
    return this.first()?.dueAt ?? null
  }

  runDue(now: Instant): void {
    const entry = this.first()
    if (entry === undefined || entry.dueAt > now) return
    this.remove(entry)
    try {
      entry.task()
    } catch (error) {
      this.onTaskError(error)
    }
  }

  private first(): PendingTask | undefined {
    let first: PendingTask | undefined
    for (const entry of this.pending) {
      if (
        first === undefined ||
        entry.dueAt < first.dueAt ||
        (entry.dueAt === first.dueAt && entry.seq < first.seq)
      ) {
        first = entry
      }
    }
    return first
  }

  private remove(entry: PendingTask): void {
    const index = this.pending.indexOf(entry)
    if (index !== -1) this.pending.splice(index, 1)
  }
}
