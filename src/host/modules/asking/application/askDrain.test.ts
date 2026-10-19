// layer: L2
// L2 (17 §1.2): the asking module's blockers of the upgrade drain (ADR-002 D8 item 2; 07 S12.14, S12.15; lead
// decision 2026-09-30 in ISSUE-032; #1290). The drain goes only when no ask is open and nothing is in flight: every
// `open` ask holds it as `open-ask`, and every `answering` ask, whose answer is being handed to the provider, holds it
// as `in-flight`. A closed ask holds nothing. The gate only reads (DrainGate contract).
import { describe, expect, it } from 'vitest'
import { runDrainGateContract } from '../../../kernel/testing/drainGate.contract'
import { createAskDrainGate } from '../index'
import { ANSWER_DWARF, answerHarness, OTHER_DWARF } from '../testing/answerHarness'

describe('the asking blockers of the upgrade drain (#1290)', () => {
  runDrainGateContract(() => {
    const h = answerHarness()
    h.permission(1)
    h.question(2, { dwarfId: OTHER_DWARF, state: 'answering' })
    h.permission(3, { state: 'cancelled', closedAt: 1 })
    return {
      gate: createAskDrainGate({ asks: h.asks }),
      open: [
        { kind: 'open-ask', dwarfId: ANSWER_DWARF },
        { kind: 'in-flight', dwarfId: OTHER_DWARF }
      ]
    }
  })

  it('[ADR-002, S12.14] with no live ask nothing of asking holds the drain', () => {
    const h = answerHarness()
    h.permission(1, { state: 'answered-in-app', closedAt: 1 })

    expect(createAskDrainGate({ asks: h.asks }).blockers()).toEqual([])
  })

  it('[ADR-002, S12.15] an open ask holds the drain until it closes', () => {
    const h = answerHarness()
    const ask = h.permission(1)
    const gate = createAskDrainGate({ asks: h.asks })

    expect(gate.blockers()).toEqual([{ kind: 'open-ask', dwarfId: ANSWER_DWARF }])

    h.asks.save({ ...ask, state: 'answered-elsewhere', closedAt: 2 })

    expect(gate.blockers()).toEqual([])
  })

  it('[ADR-002, S12.15] an answer in flight holds the drain as in-flight', () => {
    const h = answerHarness()
    h.question(1, { state: 'answering' })

    expect(createAskDrainGate({ asks: h.asks }).blockers()).toEqual([
      { kind: 'in-flight', dwarfId: ANSWER_DWARF }
    ])
  })
})
