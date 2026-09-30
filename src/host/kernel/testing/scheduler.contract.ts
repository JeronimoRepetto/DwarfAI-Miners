// The Scheduler conformance suite (16 §2.8, 17 §1.3): run against FakeScheduler and NodeScheduler.
// Time moves only through the subject's own `advance`, so no real timer ever runs here (L3).
import { describe, expect, it } from 'vitest'
import type { Scheduler } from '../ports/scheduler'

export interface SchedulerSubject {
  scheduler: Scheduler
  /** Moves the subject's time forward by `ms`, running every task that falls due. */
  advance(ms: number): void
}

export interface SchedulerHooks {
  /** Where the subject reports a task that threw (16 §3: logged, not rethrown). */
  onTaskError(error: unknown): void
}

export function runSchedulerContract(
  makeSubject: (hooks: SchedulerHooks) => SchedulerSubject
): void {
  describe('Scheduler contract', () => {
    const setUp = (): SchedulerSubject & { reported: unknown[] } => {
      const reported: unknown[] = []
      const subject = makeSubject({ onTaskError: (error) => reported.push(error) })
      return { ...subject, reported }
    }

    it('[ADR-004] a task runs once, after its delay, in due order', () => {
      const { scheduler, advance } = setUp()
      const ran: string[] = []
      scheduler.after(30, () => ran.push('thirty'))
      scheduler.after(10, () => ran.push('ten'))
      scheduler.after(20, () => ran.push('twenty-a'))
      scheduler.after(20, () => ran.push('twenty-b'))

      advance(9)
      expect(ran).toEqual([])
      advance(1)
      expect(ran).toEqual(['ten'])
      advance(20)
      expect(ran).toEqual(['ten', 'twenty-a', 'twenty-b', 'thirty'])
      advance(1_000)
      expect(ran).toEqual(['ten', 'twenty-a', 'twenty-b', 'thirty'])
    })

    it('[ADR-004] cancel before fire prevents the run; cancel after fire is a no-op; cancel twice is idempotent', () => {
      const { scheduler, advance } = setUp()
      const ran: string[] = []
      const early = scheduler.after(5, () => ran.push('early'))
      const cancelled = scheduler.after(10, () => ran.push('cancelled'))
      const kept = scheduler.after(15, () => ran.push('kept'))

      cancelled.cancel()
      cancelled.cancel()
      advance(5)
      early.cancel()
      early.cancel()
      advance(10)

      expect(ran).toEqual(['early', 'kept'])
      kept.cancel()
      advance(100)
      expect(ran).toEqual(['early', 'kept'])
    })

    it('[ADR-004] a throwing task is reported and does not stop later tasks', () => {
      const { scheduler, advance, reported } = setUp()
      const ran: string[] = []
      const failure = new Error('task failed')
      scheduler.after(10, () => {
        throw failure
      })
      scheduler.after(10, () => ran.push('same instant'))
      scheduler.after(20, () => ran.push('later'))

      expect(() => advance(20)).not.toThrow()
      expect(ran).toEqual(['same instant', 'later'])
      expect(reported).toEqual([failure])
    })
  })
}
