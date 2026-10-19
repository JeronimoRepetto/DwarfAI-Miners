import { describe, expect, it } from 'vitest'
import type { EventId } from '../domain/values'
import { runEventBusContract, type ContractEvent } from '../testing/eventBus.contract'
import { RecordingEventBus } from './RecordingEventBus'

describe('RecordingEventBus', () => {
  runEventBusContract((hooks) => new RecordingEventBus<ContractEvent>(hooks))

  it('[ADR-004] records every accepted event in publish order and keeps handler failures', () => {
    const bus = new RecordingEventBus<ContractEvent>()
    const failure = new Error('handler failed')
    bus.subscribe('ContractBeta', () => {
      throw failure
    })
    const beta: ContractEvent = {
      type: 'ContractBeta',
      v: 1,
      id: 'event-b' as EventId,
      at: 2,
      hostEpoch: 'epoch-1',
      payload: { s: 'b' }
    }
    const alpha: ContractEvent = {
      ...beta,
      type: 'ContractAlpha',
      id: 'event-a' as EventId,
      payload: { n: 1 }
    }

    bus.publish(alpha)
    bus.publish(beta)

    expect(bus.published).toEqual([alpha, beta])
    expect(bus.ofType('ContractBeta')).toEqual([beta])
    expect(bus.handlerErrors).toEqual([{ eventType: 'ContractBeta', error: failure }])
  })
})
