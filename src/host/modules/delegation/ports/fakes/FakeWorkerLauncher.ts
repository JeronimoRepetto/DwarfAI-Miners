// The WorkerLauncher double (16 §4.8 `FakeWorkerLauncher`, with the AMENDMENT-15 signature). A
// test queues each settlement it wants, in call order, and reads back every launch it was asked
// for. A call with nothing queued, or a queued `'reject'`, rejects. Never imported by production
// code (R14).
import type { LaunchFailureCause } from '../../../../kernel/domain/sharedContracts'
import type { DwarfId, Result } from '../../../../kernel/domain/values'
import type { JevSuggestionView, WorkerLauncher } from '../subtaskRouting'

type Settlement = Result<DwarfId, LaunchFailureCause>

/** One `launchWorker` call as the double received it. */
export interface LaunchedWorker {
  delegationId: string
  parent: DwarfId
  pick: JevSuggestionView
  task: string
}

export class FakeWorkerLauncher implements WorkerLauncher {
  readonly calls: LaunchedWorker[] = []
  private readonly settlements: (Settlement | 'reject')[] = []

  /** Queues the next settlement `launchWorker` resolves with (or `'reject'`). */
  queue(settlement: Settlement | 'reject'): void {
    this.settlements.push(settlement)
  }

  launchWorker(
    delegationId: string,
    parent: DwarfId,
    pick: JevSuggestionView,
    task: string
  ): Promise<Settlement> {
    this.calls.push({ delegationId, parent, pick, task })
    const next = this.settlements.shift()
    if (next === undefined) {
      return Promise.reject(new Error('FakeWorkerLauncher: launchWorker() with nothing queued'))
    }
    if (next === 'reject') return Promise.reject(new Error('FakeWorkerLauncher: rejected'))
    return Promise.resolve(next)
  }
}
