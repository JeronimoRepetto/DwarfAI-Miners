// layer: L2
// L2 (17 §1.2): the broker's `setStep` (16 §4.7 row `setStep`; ADR-010 item 9; 07 S6.04; INV-75;
// OQ-03, PO #92) over the in-memory doubles of answerHarness.ts — `InMemoryAskRepository` and a
// `RecordingEventBus` that refuses a publish inside a transaction (16 §2.3).
//
// TC-129-01 (an open front ask: `currentStep` changes and one `AskStepChanged` follows),
// TC-129-02 (a closed, unknown or queued ask: nothing written, nothing published, no throw).
import { describe, expect, it } from 'vitest'
import type { AskId } from '../../../kernel/domain/values'
import {
  ANSWER_DWARF,
  ANSWER_EPOCH,
  ANSWER_T0,
  answerHarness,
  OTHER_DWARF
} from '../testing/answerHarness'

describe('AskBroker.setStep (16 §4.7 row setStep; 07 S6.04)', () => {
  it('[US-ASK-001.AC06, S6.04, INV-75] advancing to the next step persists the new current step and publishes AskStepChanged once', () => {
    const h = answerHarness()
    const ask = h.question(1)
    h.clock.advance(2_000)
    const transactionsBefore = h.transactions()

    h.steps.setStep(ask.id, 1)

    expect(h.asks.byId(h.askId(1))).toEqual({ ...ask, currentStep: 1 })
    // One transaction, and the event after its commit (the bus refuses a publish inside one).
    expect(h.transactions() - transactionsBefore).toBe(1)
    expect(h.eventTypes()).toEqual(['AskStepChanged'])
    expect(h.bus.ofType('AskStepChanged')).toEqual([
      expect.objectContaining({
        v: 1,
        at: ANSWER_T0 + 2_000,
        hostEpoch: ANSWER_EPOCH,
        payload: { askId: ask.id as AskId, currentStep: 1 }
      })
    ])
  })

  it('[US-ASK-001.AC07] going back to an answered step persists that step and never stores its pick', () => {
    const h = answerHarness()
    const ask = h.question(1, { currentStep: 2 })

    h.steps.setStep(ask.id, 1)

    // The row holds the step and nothing else: the pick given on step 1 stays in the UI session
    // store (`ask-picks`, 14 §3.9), never in the Host (OQ-03).
    const stored = h.asks.byId(h.askId(1))
    expect(stored).toEqual({ ...ask, currentStep: 1 })
    expect(Object.keys(stored ?? {}).sort()).toEqual(Object.keys(ask).sort())
    expect(h.bus.ofType('AskStepChanged').map((event) => event.payload)).toEqual([
      { askId: ask.id, currentStep: 1 }
    ])
  })

  it('[US-ASK-006.AC07] after leaving the chat and coming back the ask reads the same current step', () => {
    const h = answerHarness()
    const ask = h.question(1)
    h.steps.setStep(ask.id, 2)

    // Leaving the chat and coming back reads the stored rows again; so does a Host restart.
    h.reboot()

    expect(h.asks.openFor(ANSWER_DWARF)).toEqual({ ...ask, currentStep: 2 })
    expect(h.asks.live()).toEqual([{ ...ask, currentStep: 2 }])
  })

  it('[ADR-010] a step for an ask that closed meanwhile, an unknown ask or a queued ask writes nothing and publishes nothing', () => {
    const h = answerHarness()
    const closed = h.question(1, { state: 'answered-elsewhere', closedAt: ANSWER_T0 + 5 })
    const front = h.question(2)
    const queued = h.question(3)
    const answering = h.permission(4, { dwarfId: OTHER_DWARF, state: 'answering' })
    const rowsBefore = structuredClone([...h.rows.asks])

    for (const [askId, step] of [
      [closed.id, 1],
      [h.askId(99), 1],
      ['not-an-ask-id', 1],
      [queued.id, 1],
      [answering.id, 1],
      // Not a step the UI can report (the transport refuses it first, 14 §3.4).
      [front.id, -1],
      [front.id, 1.5]
    ] as const) {
      expect(() => h.steps.setStep(askId, step), `${askId} ${step}`).not.toThrow()
    }

    expect([...h.rows.asks]).toEqual(rowsBefore)
    expect(h.eventTypes()).toEqual([])
  })

  it('[ADR-010] the same step twice publishes nothing the second time', () => {
    const h = answerHarness()
    const ask = h.question(1)

    h.steps.setStep(ask.id, 1)
    const rowsAfterFirst = structuredClone([...h.rows.asks])
    h.steps.setStep(ask.id, 1)
    // The step the ask is already on, from the start, changes nothing either.
    h.steps.setStep(h.question(2, { dwarfId: OTHER_DWARF }).id, 0)

    expect([...h.rows.asks].filter(([id]) => id === ask.id)).toEqual(
      rowsAfterFirst.filter(([id]) => id === ask.id)
    )
    expect(h.eventTypes()).toEqual(['AskStepChanged'])
  })
})
