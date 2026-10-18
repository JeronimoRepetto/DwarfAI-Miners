import { describe, expect, it } from 'vitest'
import type { Delivery, DwarfId, HostFrame, MessageId } from '@dwarfai/contracts'
import { applyDeliveryFrame, deliveryMarksOf } from './deliveryMarks'

const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
const id = (n: number) =>
  `01920000-0000-7000-8000-00000000e${String(n).padStart(3, '0')}` as MessageId

function delivery(n: number, phase: Delivery['phase']): Delivery {
  return { messageId: id(n), dwarfId: BORIN, kind: 'message', phase, attempts: 1, phaseAt: n }
}

function frame(name: string, data: unknown): HostFrame {
  return { type: 'evt', seq: 1, epoch: 'epoch-1', name, data } as HostFrame
}

describe('delivery marks folds', () => {
  it('[ADR-022] the marks of a snapshot are keyed by message, every page joined, other sections ignored', () => {
    const marks = deliveryMarksOf([
      { section: 'marks', data: [delivery(1, 'sending')] },
      { section: 'tails', data: [] },
      { section: 'marks', data: [delivery(2, 'reacted')] }
    ])
    expect([...marks.entries()]).toEqual([
      [id(1), delivery(1, 'sending')],
      [id(2), delivery(2, 'reacted')]
    ])
  })

  it('[ADR-022] message.delivery replaces its message mark whole, and any other or malformed frame changes nothing', () => {
    const marks = deliveryMarksOf([{ section: 'marks', data: [delivery(1, 'sending')] }])
    applyDeliveryFrame(marks, frame('conversation.appended', { dwarfId: BORIN, messages: [] }))
    applyDeliveryFrame(marks, frame('message.delivery', { delivery: { messageId: id(1) } }))
    expect(marks.get(id(1))).toEqual(delivery(1, 'sending'))
    applyDeliveryFrame(marks, frame('message.delivery', { delivery: delivery(1, 'failed') }))
    expect(marks.get(id(1))).toEqual(delivery(1, 'failed'))
  })
})
