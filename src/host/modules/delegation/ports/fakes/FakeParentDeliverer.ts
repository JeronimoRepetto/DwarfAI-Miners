// The ParentDeliverer double (16 §4.8 `FakeParentDeliverer`). A test queues each answer it wants,
// in call order, and reads back every push it was asked for: one call per handoff proves the push
// is never retried (ADR-013 O-13b). A call with nothing queued, or a queued `'reject'`, rejects.
// Never imported by production code (R14).
import type { DwarfId, Result } from '../../../../kernel/domain/values'
import type { ParentDeliverer } from '../delegationServer'

type Delivery = Result<'delivered', 'cannot-receive' | 'failed'>

/** One `deliver` call as the double received it. */
export interface DeliveredHandoff {
  parent: DwarfId
  text: string
}

export class FakeParentDeliverer implements ParentDeliverer {
  readonly calls: DeliveredHandoff[] = []
  private readonly answers: (Delivery | 'reject')[] = []

  /** Queues the next answer `deliver` resolves with (or `'reject'`: the call rejects). */
  queue(answer: Delivery | 'reject'): void {
    this.answers.push(answer)
  }

  deliver(parent: DwarfId, text: string): Promise<Delivery> {
    this.calls.push({ parent, text })
    const next = this.answers.shift()
    if (next === undefined) {
      return Promise.reject(new Error('FakeParentDeliverer: deliver() with nothing queued'))
    }
    if (next === 'reject') return Promise.reject(new Error('FakeParentDeliverer: rejected'))
    return Promise.resolve(next)
  }
}
