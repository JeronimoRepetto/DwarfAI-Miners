// layer: L2
// The Host's DrainGate binding (ADR-002 D8 items 2–3; 07 S12.14, S12.15; lead decision 2026-09-30 in ISSUE-032;
// #1290): the upgrade drain is built before boot step 4 wires the modules that hold it, so the gate reports what
// every module bound so far reports, and nothing before any is bound; an ask that closes asks the drain again at once.
import { describe, expect, it } from 'vitest'
import type { AskId, DwarfId, EventId, HostEpoch, Instant } from '../kernel/domain/values'
import { FakeDrainGate } from '../kernel/fakes/FakeDrainGate'
import { RecordingEventBus } from '../kernel/fakes/RecordingEventBus'
import { runDrainGateContract } from '../kernel/testing/drainGate.contract'
import type { AskingEvent } from '../modules/asking'
import { createHostDrainGate, routeDrainRechecks } from './hostDrainGate'

const DWARF = '00000000-0000-7000-8000-000000129001' as DwarfId

function askClosed(): AskingEvent {
  return {
    type: 'AskClosed',
    v: 1,
    id: 'event-1' as EventId,
    at: 1 as Instant,
    hostEpoch: 'epoch-1290' as HostEpoch,
    payload: { askId: 'ask-1' as AskId, dwarfId: DWARF, reason: 'answered-elsewhere' }
  }
}

describe('the Host DrainGate binding (#1290)', () => {
  describe('with nothing bound', () => {
    runDrainGateContract(() => ({ gate: createHostDrainGate(), open: [] }))
  })

  describe('with two modules bound', () => {
    runDrainGateContract(() => {
      const gate = createHostDrainGate()
      gate.bind(new FakeDrainGate([{ kind: 'open-ask', dwarfId: DWARF }]))
      gate.bind(new FakeDrainGate([{ kind: 'in-flight' }]))
      return { gate, open: [{ kind: 'open-ask', dwarfId: DWARF }, { kind: 'in-flight' }] }
    })
  })

  it('[ADR-002, S12.15] a module bound after the drain was built holds it, read at each ask', () => {
    const gate = createHostDrainGate()
    const asking = new FakeDrainGate()
    gate.bind(asking)

    expect(gate.blockers()).toEqual([])

    asking.block({ kind: 'open-ask', dwarfId: DWARF })

    expect(gate.blockers()).toEqual([{ kind: 'open-ask', dwarfId: DWARF }])
  })

  it('[ADR-002, S12.14] an ask that closes asks the drain again at once, until the route stops', () => {
    const bus = new RecordingEventBus<AskingEvent>()
    const rechecks: string[] = []
    // A typed constant, not an inline literal: TypeScript 6.0.3 crashes checking that call.
    const deps: Parameters<typeof routeDrainRechecks>[0] = {
      events: bus,
      drain: { recheck: () => rechecks.push('x') }
    }
    const stop = routeDrainRechecks(deps)

    bus.publish(askClosed())

    expect(rechecks).toHaveLength(1)

    stop()
    bus.publish(askClosed())

    expect(rechecks).toHaveLength(1)
  })
})
