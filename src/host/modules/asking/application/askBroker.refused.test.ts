// layer: L2
// L2 (17 §1.2): a refused answer and an ask that is gone (ADR-010 items 5, 13; ADR-022; 07 S6.09,
// S6.10, S6.15, S6.21, S6.22, S7.08; 16 §4.7 rows `answerPermission` / `answerQuestion`; 09 §8.2)
// over the in-memory doubles of answerHarness.ts.
//
// TC-131-01 (a refusal other than `ask-closed` reopens the ask, the record is `failed{refused,
// reason}`, `AskReopened`), TC-131-02 (a re-answer keeps exactly one record, with the new text),
// TC-131-03 (an `ask-closed` refusal brings no card back and the ask keeps its closing state).
import { describe, expect, it } from 'vitest'
import type { AnswerOutcome } from '../../../kernel/domain/sharedContracts'
import { ANSWER_DWARF, ANSWER_T0, answerHarness } from '../testing/answerHarness'

const R1 = '01890a5d-ac96-774b-bcce-000000000131'
const R2 = '01890a5d-ac96-774b-bcce-000000000132'

/** Lets every settled promise run its continuations. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('AskBroker after a refused answer', () => {
  it('[US-ASK-007.AC01, S7.08] a refused answer leaves its Answers: record failed with the refusal reason and no retry or copy', async () => {
    const h = answerHarness()
    const ask = h.permission(1)
    h.channel.script({ kind: 'refused', reason: 'invalid-answer' })
    h.clock.advance(1_000)

    const outcome = await h.paths.answerPermission(ask.id, 'allow', R1)

    expect(outcome).toEqual({ kind: 'refused', reason: 'invalid-answer' })
    // ✕ with the reason verbatim; a `refused` failure is never retried and offers no copy
    // (ADR-010 item 5, S7.08): the delivery holds nothing else.
    expect(h.records()).toEqual([
      expect.objectContaining({
        text: 'Answers:\n\n- Bash · Run pnpm test: **Allow**',
        delivery: {
          phase: 'failed',
          failure: { kind: 'refused', reason: 'invalid-answer' },
          attempts: 1,
          phaseAt: ANSWER_T0 + 1_000
        }
      })
    ])
    expect(h.bus.ofType('MessageDeliveryFailed')[0]?.payload).toEqual({
      messageId: h.records()[0]?.id,
      dwarfId: ANSWER_DWARF,
      failure: { kind: 'refused', reason: 'invalid-answer' }
    })
    // No automatic re-send.
    await flush()
    expect(h.channel.calls).toHaveLength(1)
    expect(h.asks.answerOf(R1)?.outcome).toEqual({ kind: 'refused', reason: 'invalid-answer' })
  })

  it('[US-ASK-007.AC02, S6.09, INV-78, BR-16] a refusal while the ask is still open returns it to open on the same step and publishes AskReopened with no alert', async () => {
    const h = answerHarness()
    const ask = h.question(2, { currentStep: 2 })
    h.channel.script({ kind: 'refused', reason: 'channel-rejected' })

    await h.paths.answerQuestion(
      ask.id,
      [
        { step: 0, option: 'All' },
        { step: 1, option: 'Yes' },
        { step: 2, option: 'No' }
      ],
      R1
    )

    // The card comes back: the dwarf's front ask, open, on the step it was left on.
    expect(h.asks.openFor(ANSWER_DWARF)).toMatchObject({
      id: ask.id,
      state: 'open',
      currentStep: 2
    })
    expect(h.asks.byId(ask.id as never)?.closedAt).toBeUndefined()
    // Exactly these events: no attention, no notice, no close.
    expect(h.eventTypes()).toEqual(['MessageSent', 'AskReopened', 'MessageDeliveryFailed'])
    expect(h.bus.ofType('AskReopened')[0]?.payload).toEqual({
      askId: ask.id,
      dwarfId: ANSWER_DWARF,
      refusal: 'channel-rejected'
    })
  })

  it('[US-ASK-007.AC03, INV-65, FM-074] answering again replaces the refused record in place and adds no second record', async () => {
    const h = answerHarness()
    const ask = h.permission(3)
    h.channel.script({ kind: 'refused', reason: 'channel-rejected' })
    await h.paths.answerPermission(ask.id, 'allow', R1)
    const [refused] = h.records()
    h.clock.advance(5_000)
    h.channel.hold = true

    const again = h.paths.answerPermission(ask.id, 'deny', R2)
    await flush()

    // "…": the same record, the new text and time, sending again on its second attempt.
    expect(h.records()).toEqual([
      {
        id: refused?.id,
        dwarfId: ANSWER_DWARF,
        askId: ask.id,
        text: 'Answers:\n\n- Bash · Run pnpm test: **Deny**',
        createdAt: ANSWER_T0 + 5_000,
        delivery: { phase: 'sending', attempts: 2, phaseAt: ANSWER_T0 + 5_000 }
      }
    ])
    expect(h.bus.ofType('MessageSent').map((event) => event.payload.messageId)).toEqual([
      refused?.id,
      refused?.id
    ])

    h.channel.release()
    expect(await again).toEqual({ kind: 'accepted' })
    // "✓": still one record for the ask.
    expect(h.records()).toEqual([
      expect.objectContaining({
        id: refused?.id,
        delivery: expect.objectContaining({ phase: 'delivered', attempts: 2 })
      })
    ])
    expect(h.asks.byId(ask.id as never)?.state).toBe('answered-in-app')
  })

  it('[US-ASK-007.AC04] after a refusal the dwarf is still asking', async () => {
    const h = answerHarness()
    const ask = h.permission(4)
    h.channel.script({ kind: 'refused', reason: 'channel-unavailable' })

    await h.paths.answerPermission(ask.id, 'allow', R1)

    // The outcome line moves only on `ask.opened` / `ask.closed` (conversation noteAsk, ISSUE-102):
    // no `AskClosed`, and the ask is still the dwarf's open front ask, so "Waiting on you" stays.
    expect(h.bus.ofType('AskClosed')).toEqual([])
    expect(h.asks.openFor(ANSWER_DWARF)).toMatchObject({ id: ask.id, state: 'open' })
  })

  it('[US-ASK-007.AC05, S6.10, S6.15, S6.22] a refusal because the ask is no longer open keeps the ask closed, marks the record ask-closed and publishes no AskReopened', async () => {
    const cases = [
      {
        // S6.10: the provider no longer holds the request.
        closing: 'answered-elsewhere',
        close: (h: ReturnType<typeof answerHarness>, _id: string) => {
          h.channel.script({ kind: 'refused', reason: 'ask-closed' })
        },
        whileInFlight: false
      },
      {
        // S6.15: the session ended while the answer was in flight.
        closing: 'closed-by-death',
        close: (h: ReturnType<typeof answerHarness>, id: string) => {
          const current = h.asks.byId(id as never)
          if (current !== null) h.seed({ ...current, state: 'closed-by-death', closedAt: 99 })
        },
        whileInFlight: true
      },
      {
        // S6.22: the turn was cancelled or the request withdrawn while the answer was in flight.
        closing: 'cancelled',
        close: (h: ReturnType<typeof answerHarness>, id: string) => {
          const current = h.asks.byId(id as never)
          if (current !== null) {
            h.paths.resolveExternally(current.dwarfId, current.providerRequestId, 'cancelled')
          }
        },
        whileInFlight: true
      }
    ] as const

    for (const { closing, close, whileInFlight } of cases) {
      const h = answerHarness()
      const ask = h.question(5)
      let answered: Promise<AnswerOutcome>
      if (whileInFlight) {
        h.channel.hold = true
        // The channel refuses for its own reason; the ask is gone, so the outcome is `ask-closed`.
        h.channel.script({ kind: 'refused', reason: 'channel-rejected' })
        answered = h.paths.answerQuestion(ask.id, [{ step: 0, option: 'All' }], R1)
        await flush()
        close(h, ask.id)
        h.channel.release()
      } else {
        close(h, ask.id)
        answered = h.paths.answerQuestion(ask.id, [{ step: 0, option: 'All' }], R1)
      }

      expect(await answered, closing).toEqual({ kind: 'refused', reason: 'ask-closed' })
      expect(h.asks.byId(ask.id as never), closing).toMatchObject({
        state: closing,
        closedAt: expect.any(Number)
      })
      // No card comes back, and the dwarf is no longer asking.
      expect(h.asks.openFor(ANSWER_DWARF), closing).toBeNull()
      expect(h.bus.ofType('AskReopened'), closing).toEqual([])
      // ✕ `ask-closed`: the renderer words it by the ask's kind ("That question is no longer open.").
      expect(h.records()[0]?.delivery, closing).toMatchObject({
        phase: 'failed',
        failure: { kind: 'refused', reason: 'ask-closed' }
      })
      expect(h.bus.ofType('MessageDeliveryFailed')[0]?.payload.failure, closing).toEqual({
        kind: 'refused',
        reason: 'ask-closed'
      })
    }
  })

  it('[S6.22] a cancellation while the answer is in flight closes the ask at once and publishes AskClosed once', async () => {
    const h = answerHarness()
    const ask = h.permission(6)
    h.channel.hold = true

    const answered = h.paths.answerPermission(ask.id, 'allow', R1)
    await flush()
    h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, 'cancelled')

    expect(h.asks.byId(ask.id as never)).toMatchObject({ state: 'cancelled', closedAt: ANSWER_T0 })
    expect(h.eventTypes()).toEqual(['MessageSent', 'AskClosed'])
    expect(h.bus.ofType('AskClosed')[0]?.payload).toEqual({
      askId: ask.id,
      dwarfId: ANSWER_DWARF,
      reason: 'cancelled'
    })

    // Even an accepted hand-over cannot reopen or re-close a cancelled ask.
    h.channel.release()
    expect(await answered).toEqual({ kind: 'refused', reason: 'ask-closed' })
    expect(h.asks.byId(ask.id as never)?.state).toBe('cancelled')
    expect(h.eventTypes()).toEqual(['MessageSent', 'AskClosed', 'MessageDeliveryFailed'])
  })

  it('[S6.21] an external resolution during the channel call is held: accepted wins, a refusal ends as ask-closed', async () => {
    const settleWith = async (result: AnswerOutcome | 'timeout') => {
      const h = answerHarness()
      const ask = h.permission(7)
      h.channel.hold = true
      if (result !== 'timeout') h.channel.script(result)
      const answered = h.paths.answerPermission(ask.id, 'allow', R1)
      await flush()

      // Twice: held once, applied once.
      h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, 'elsewhere')
      h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, 'elsewhere')
      // Held: nothing changes until the channel call returns.
      expect(h.asks.byId(ask.id as never)?.state).toBe('answering')
      expect(h.eventTypes()).toEqual(['MessageSent'])

      if (result === 'timeout') h.clock.advance(30_000)
      else h.channel.release()
      const outcome = await answered
      // A resolution after the result finds the ask closed and changes nothing.
      h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, 'elsewhere')
      return {
        outcome,
        state: h.asks.byId(ask.id as never)?.state,
        delivery: h.records()[0]?.delivery,
        events: h.eventTypes(),
        closed: h.bus.ofType('AskClosed').map((event) => event.payload.reason)
      }
    }

    // The in-app answer is what resolved it (S6.08).
    expect(await settleWith({ kind: 'accepted' })).toMatchObject({
      outcome: { kind: 'accepted' },
      state: 'answered-in-app',
      delivery: { phase: 'delivered' },
      events: ['MessageSent', 'AskClosed', 'MessageHandedOver'],
      closed: ['answered-in-app']
    })
    // A refusal, or no result within the bound, ends as S6.10: ✕ ask-closed, no card.
    for (const result of [{ kind: 'refused', reason: 'channel-rejected' }, 'timeout'] as const) {
      expect(await settleWith(result)).toMatchObject({
        outcome: { kind: 'refused', reason: 'ask-closed' },
        state: 'answered-elsewhere',
        delivery: { phase: 'failed', failure: { kind: 'refused', reason: 'ask-closed' } },
        events: ['MessageSent', 'AskClosed', 'MessageDeliveryFailed'],
        closed: ['answered-elsewhere']
      })
    }
  })

  it("[US-ASK-007.AC06] the record's delivery marks are the ones the dwarf's marker reads, reacted only after activity correlated to the answer", async () => {
    const h = answerHarness()
    const ask = h.permission(8)
    h.channel.hold = true

    const answered = h.paths.answerPermission(ask.id, 'allow', R1)
    await flush()
    const [record] = h.records()
    // "…": the marker reads the record's own delivery, named by its message id.
    expect(record?.delivery.phase).toBe('sending')
    expect(h.bus.ofType('MessageSent')[0]?.payload).toEqual({
      messageId: record?.id,
      dwarfId: ANSWER_DWARF,
      kind: 'answers-record'
    })

    h.channel.release()
    await answered
    // "✓": handed over. The broker never marks "✓✓": that waits for activity correlated to the
    // answer (machine 7, conversation), so the record stays `delivered` here.
    expect(h.records()[0]?.delivery.phase).toBe('delivered')
    expect(h.bus.ofType('MessageHandedOver')[0]?.payload).toEqual({
      messageId: record?.id,
      dwarfId: ANSWER_DWARF,
      confidence: 'confirmed'
    })
  })

  it('[US-ASK-007.AC07, FM-075] Answers: records are still in the conversation after a Host restart', async () => {
    const h = answerHarness()
    const ask = h.permission(9)
    h.channel.script({ kind: 'refused', reason: 'channel-rejected' })
    await h.paths.answerPermission(ask.id, 'allow', R1)
    const before = h.records()

    // A Host restart: new answer paths over the same stored rows.
    const restarted = h.reboot()

    expect(h.records()).toEqual(before)
    expect(h.asks.recordOf(ask.id as never)).toBe(before[0]?.id)
    // The reopened card answered after the restart still replaces that same record.
    expect(await restarted.answerPermission(ask.id, 'deny', R2)).toEqual({ kind: 'accepted' })
    expect(h.records()).toEqual([
      expect.objectContaining({
        id: before[0]?.id,
        text: 'Answers:\n\n- Bash · Run pnpm test: **Deny**',
        delivery: expect.objectContaining({ phase: 'delivered', attempts: 2 })
      })
    ])
  })
})
