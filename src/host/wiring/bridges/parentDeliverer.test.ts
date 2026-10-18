// layer: L2
// L2 (17 §1.2): the `ParentDeliverer` bridge (16 §4.8 rows `ParentDeliverer` and the bridges row;
// ADR-013 item 6): delegation → conversation `deliverInvisibly`, turn-input only, not retried, over
// a recording `deliverInvisibly` written inline (R15).
import { describe, expect, it } from 'vitest'
import type { DwarfId, Result } from '../../kernel/domain/values'
import { markHandoff } from '../../modules/conversation'
import { createParentDeliverer } from './parentDeliverer'

const PARENT = '00000000-0000-7000-8000-0000000c2071' as DwarfId
const MARKED = markHandoff('00000000-0000-7000-8000-0000000c2072', 'The shafts are mapped.')

type Answer = Result<'delivered', 'cannot-receive' | 'failed'>

function conversation(answer: Answer | 'reject') {
  const calls: Array<{ parent: DwarfId; text: string }> = []
  return {
    calls,
    deliverInvisibly(parent: DwarfId, text: string): Promise<Answer> {
      calls.push({ parent, text })
      return answer === 'reject' ? Promise.reject(new Error('push threw')) : Promise.resolve(answer)
    }
  }
}

describe('ParentDeliverer bridge (16 §4.8)', () => {
  it('[ADR-013] the parent and the marked text go to conversation deliverInvisibly once, and its answer comes back as given', async () => {
    for (const answer of [
      { ok: true, value: 'delivered' },
      { ok: false, error: 'cannot-receive' },
      { ok: false, error: 'failed' }
    ] satisfies Answer[]) {
      const target = conversation(answer)
      const deliverer = createParentDeliverer({ conversation: target })

      expect(await deliverer.deliver(PARENT, MARKED)).toStrictEqual(answer)
      expect(target.calls).toStrictEqual([{ parent: PARENT, text: MARKED }])
    }
  })

  it('[ADR-013] a push that throws is answered failed and is not retried', async () => {
    const target = conversation('reject')
    const deliverer = createParentDeliverer({ conversation: target })

    expect(await deliverer.deliver(PARENT, MARKED)).toStrictEqual({ ok: false, error: 'failed' })
    expect(target.calls).toHaveLength(1)
  })
})
